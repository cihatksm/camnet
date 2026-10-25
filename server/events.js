import { EventEmitter } from 'node:events';

/** Shared event bus for server-side events (publisher online/offline, etc.) */
export const events = new EventEmitter();
events.setMaxListeners(50);
