import { getUniqueId } from '../../utils/getUniqueId';
import { getFilenameWithoutExtension } from '../../utils/getFilenameWithoutExtension';
import { getExtensionFromFilename } from '../../utils/getExtensionFromFilename';
import { ItemStatus } from '../enum/ItemStatus';
import { on } from './on';
import { createFileStub } from './createFileStub';
import { createObject } from '../../utils/createObject';
import { FileOrigin } from '../../app/enum/FileOrigin';
import { isObject } from '../../utils/isObject';
import { isFile } from '../../utils/isFile';
import { deepCloneObject } from '../../utils/deepCloneObject';

export const createItem = (origin = null, serverFileReference = null, file = null) => {
    // unique id for this item, is used to identify the item across views
    const id = getUniqueId();

    /**
     * Internal item state
     */
    const state = {

        // is archived
        archived: false,

        // if is frozen, no longer fires events
        frozen: false,

        // removed from view
        released: false,

        // original source
        source: null,

        // file model reference
        file,

        // id of file on server
        serverFileReference,

        // current item status
        status: serverFileReference
            ? ItemStatus.PROCESSING_COMPLETE
            : ItemStatus.INIT,

        // active processes
        activeLoader: null,
        activeProcessor: null,
    };

    // callback used when abort processing is called to link back to the resolve method
    let abortProcessingRequestComplete = null;

    /**
     * Externally added item metadata
     */
    const metadata = {};

    // item data
    const setStatus = status => (state.status = status);

    // fire event unless the item has been archived
    const fire = (event, ...params) => {
        if (state.released || state.frozen) return;
        api.fire(event, ...params);
    }

    // file data
    const getFileExtension = () => getExtensionFromFilename(state.file.name);
    const getFileType = () => state.file.type;
    const getFileSize = () => state.file.size;
    const getFile = () => state.file;


    //
    // logic to load a file
    //
    const load = (source, loader, onload) => {

        // remember the original item source
        state.source = source;
        
        // file stub is already there
        if (state.file) {
            fire('load-skip');
            return;
        }

        // set a stub file object while loading the actual data
        state.file = createFileStub(source);

        // starts loading
        loader.on('init', () => {
            fire('load-init');
        });

        // we'eve received a size indication, let's update the stub
        loader.on('meta', meta => {

            // set size of file stub
            state.file.size = meta.size;

            // set name of file stub
            state.file.filename = meta.filename;

            // if has received source, we done
            if (meta.source) {
                origin = FileOrigin.LIMBO;
                state.serverFileReference = meta.source;
                state.status = ItemStatus.PROCESSING_COMPLETE;
            }

            // size has been updated
            fire('load-meta');
        });

        // the file is now loading we need to update the progress indicators
        loader.on('progress', progress => {
            setStatus(ItemStatus.LOADING);

            fire('load-progress', progress);
        });

        // an error was thrown while loading the file, we need to switch to error state
        loader.on('error', error => {
            setStatus(ItemStatus.LOAD_ERROR);

            fire('load-request-error', error);
        });

        // user or another process aborted the file load (cannot retry)
        loader.on('abort', () => {
            setStatus(ItemStatus.INIT);
            fire('load-abort');
        });

        // done loading
        loader.on('load', file => {

            // as we've now loaded the file the loader is no longer required
            state.activeLoader = null;

            // called when file has loaded succesfully
            const success = result => {
                
                // set (possibly) transformed file
                state.file = isFile(result) ? result : state.file;

                // file received
                if (origin === FileOrigin.LIMBO && state.serverFileReference) {
                    setStatus(ItemStatus.PROCESSING_COMPLETE);
                }
                else {
                    setStatus(ItemStatus.IDLE);
                }
                
                fire('load');
            };

            const error = result => {
                // set original file
                state.file = file;
                fire('load-meta');

                setStatus(ItemStatus.LOAD_ERROR);
                fire('load-file-error', result);
            };

            // if we already have a server file reference, we don't need to call the onload method
            if (state.serverFileReference) {
                success(file);
                return;
            }

            // no server id, let's give this file the full treatment
            onload(file, success, error);
        });

        // set loader source data
        loader.setSource(source);

        // set as active loader
        state.activeLoader = loader;

        // load the source data
        loader.load();
    };

    const retryLoad = () => {
        if (!state.activeLoader) {
            return;
        }
        state.activeLoader.load();
    };

    const abortLoad = () => {
        if (state.activeLoader) {
            state.activeLoader.abort();
            return;
        }
        setStatus(ItemStatus.INIT);
        fire('load-abort');
    };


    //
    // logic to process a file
    //
    const process = (processor, onprocess) => {

        // now processing
        setStatus(ItemStatus.PROCESSING);

        // reset abort callback
        abortProcessingRequestComplete = null;

        // if no file loaded we'll wait for the load event
        if (!(state.file instanceof Blob)) {
            api.on('load', () => {
                process(processor, onprocess);
            });
            return;
        }

        // setup processor
        processor.on('load', serverFileReference => {

            // need this id to be able to revert the upload
            state.serverFileReference = serverFileReference;

        });

        processor.on('load-perceived', serverFileReference => {
            // no longer required
            state.activeProcessor = null;

            // need this id to be able to rever the upload
            state.serverFileReference = serverFileReference;

            setStatus(ItemStatus.PROCESSING_COMPLETE);
            fire('process-complete', serverFileReference);
        });

        processor.on('start', () => {
            fire('process-start');
        });

        processor.on('error', error => {
            state.activeProcessor = null;
            setStatus(ItemStatus.PROCESSING_ERROR);
            fire('process-error', error);
        });

        processor.on('abort', serverFileReference => {
            state.activeProcessor = null;

            // if file was uploaded but processing was cancelled during perceived processor time store file reference
            state.serverFileReference = serverFileReference;

            setStatus(ItemStatus.IDLE);
            fire('process-abort');

            // has timeout so doesn't interfere with remove action
            if (abortProcessingRequestComplete) {
                abortProcessingRequestComplete();
            }
        });

        processor.on('progress', progress => {
            fire('process-progress', progress);
        });

        // when successfully transformed
        const success = file => {
            
            // if was archived in the mean time, don't process
            if (state.archived) return;

            // process file!
            processor.process(file, { ...metadata });
        };

        // something went wrong during transform phase
        const error = result => {};

        // start processing the file
        onprocess(state.file, success, error);

        // set as active processor
        state.activeProcessor = processor;
    };

    const requestProcessing = () => {
        setStatus(ItemStatus.PROCESSING_QUEUED);
    }

    const abortProcessing = () => new Promise((resolve) => {

        if (!state.activeProcessor) {

            setStatus(ItemStatus.IDLE);
            fire('process-abort');
            
            resolve();
            return;
        }
        
        abortProcessingRequestComplete = () => {
            resolve();
        }
        
        state.activeProcessor.abort();
    });
    

    //
    // logic to revert a processed file
    //
    const revert = (revertFileUpload, forceRevert) => new Promise((resolve, reject) => {

        // cannot revert without a server id for this process
        if (state.serverFileReference === null) {
            resolve();
            return;
        }

        // revert the upload (fire and forget)
        revertFileUpload(
            state.serverFileReference,
            () => {

                // reset file server id as now it's no available on the server
                state.serverFileReference = null;
                resolve();
            },
            error => {
                // don't set error state when reverting is optional, it will always resolve
                if (!forceRevert) {
                    resolve();
                    return;
                }

                // oh no errors
                setStatus(ItemStatus.PROCESSING_REVERT_ERROR);
                fire('process-revert-error');
                reject(error);
            }
        );

        // fire event
        setStatus(ItemStatus.IDLE);
        fire('process-revert');
    });


    // exposed methods
    const setMetadata = (key, value, silent) => {
        const keys = key.split('.');
        const root = keys[0];
        const last = keys.pop();
        let data = metadata;
        keys.forEach(key => data = data[key]);

        // compare old value against new value, if they're the same, we're not updating
        if (JSON.stringify(data[last]) === JSON.stringify(value)) {
            return;
        }

        // update value
        data[last] = value;

        if (silent) return;

        fire('metadata-update', {
            key: root,
            value: metadata[root]
        });
    }

    const getMetadata = (key) => deepCloneObject(key ? metadata[key] : metadata);

    const api = {
        id: { get: () => id },
        origin: { get:() => origin },
        serverId: { get: () => state.serverFileReference },
        status: { get: () => state.status },
        filename: { get: () => state.file.name },
        filenameWithoutExtension: { get: () => getFilenameWithoutExtension(state.file.name) },
        fileExtension: { get: getFileExtension },
        fileType: { get: getFileType },
        fileSize: { get: getFileSize },
        file: { get: getFile },

        source: { get: () => state.source },

        getMetadata,
        setMetadata: (key, value, silent) => {
            if (isObject(key)) {
                const data = key;
                Object.keys(data).forEach(key => {
                    setMetadata(key, data[key], value);
                })
                return key;
            }
            setMetadata(key, value, silent);
            return value;
        },

        extend: (name, handler) => itemAPI[name] = handler,

        abortLoad,
        retryLoad,
        requestProcessing,
        abortProcessing,

        load,
        process,
        revert,

        ...on(),

        freeze: () => state.frozen = true,

        release: () => state.released = true,
        released: { get: () => state.released },

        archive: () => state.archived = true,
        archived: { get: () => state.archived }
    };

    // create it here instead of returning it instantly so we can extend it later
    const itemAPI = createObject(api);

    return itemAPI;

};
