// syncEngine.js

import {
    getPendingSyncBatch,
    markActionSyncing,
    confirmActionSynced,
    markActionFailed,
    getAuthToken
} from './SQLite.js';

class SyncEngine {
    constructor() {
        this.isRunning   = false;
        this.syncTimeout = null;
        this.backoffMs   = 5_000;    
        this.MAX_BACKOFF = 300_000;  
    }

    start() {
        window.addEventListener('online',  () => this._goOnline());
        window.addEventListener('offline', () => this._goOffline());
        if (navigator.onLine) this._schedule();
        console.log('SyncEngine Started');
    }

    stop() {
        clearTimeout(this.syncTimeout);
        this.isRunning = false;
    }

    nudge() {
        if (navigator.onLine && !this.isRunning) {
            clearTimeout(this.syncTimeout);
            this._processBatch();
        }
    }

    _goOnline() {
        console.log('SyncEngine Online — resuming');
        this.backoffMs = 5_000;
        this._schedule();
    }

    _goOffline() {
        console.log('SyncEngine Offline — paused');
        clearTimeout(this.syncTimeout);
    }

    _schedule() {
        clearTimeout(this.syncTimeout);
        this.syncTimeout = setTimeout(() => this._processBatch(), this.backoffMs);
    }

    async _processBatch() {
        if (!navigator.onLine || this.isRunning) {
            this._schedule();
            return;
        }

       this.isRunning = true;
    let batch = [];

    try {
        batch = await getPendingSyncBatch(5);

            if (batch.length === 0) {
                this.isRunning = false;
                this._schedule();
                return;
            }

            // Lock all items so they aren't picked up again mid-flight
            await Promise.all(batch.map(a => markActionSyncing(a._id)));

            const token = await getAuthToken();
            
            // Check if token exists
            if (!token) {
                throw new Error('No authentication token available');
            }

            const response = await fetch('/api/sync/batch', {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type':  'application/json'
                },
                body: JSON.stringify({
                    actions: batch.map(a => ({
                        localId:    a._id,
                        type:       a.type,
                        payload:    a.payload,
                        checksum:   a.checksum,
                        clientTime: a.timestamp
                    }))
                }),
                signal: AbortSignal.timeout(15_000) 
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const { results } = await response.json();

            // Process each result individually to handle failures better
            for (const result of results) {
                try {
                    if (result.status === 'confirmed') {
                        await confirmActionSynced(
                            result.localId,
                            result.serverId,
                            result.serverTime
                        );
                    } else {
                        await markActionFailed(result.localId, result.error || 'Server rejected');
                    }
                } catch (err) {
                    console.error(`[SyncEngine] Failed to process result for ${result.localId}:`, err);
                    // Don't throw, try to continue with other items
                    await markActionFailed(result.localId, err.message);
                }
            }

            this.backoffMs = 5_000;

        } catch (err) {
            console.error('[SyncEngine] Batch failed:', err.message);

            this.backoffMs = Math.min(this.backoffMs * 2, this.MAX_BACKOFF);

            // Only mark as failed if we have items to mark and it's not a token error
            if (batch && batch.length > 0 && !err.message.includes('No authentication token')) {
                try {
                    await Promise.all(
                        batch.map(a => markActionFailed(a._id, err.message))
                    );
                } catch (markErr) {
                    console.error('[SyncEngine] Failed to mark actions as failed:', markErr);
                }
            }
        } finally {
            this.isRunning = false;
            this._schedule();
        }
    }
}

export const syncEngine = new SyncEngine();