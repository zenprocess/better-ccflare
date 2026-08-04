import { EventEmitter } from "node:events";

class RequestEventBus extends EventEmitter {}
export const requestEvents = new RequestEventBus();
