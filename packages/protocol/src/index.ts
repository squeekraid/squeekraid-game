// Public subset of the flight protocol used by the game client: message shapes and the client-side
// Gear activation state machine. The server's decisions and checks are not part of this repository.
export { GearSlot, GearType, GearUseRequest, GearUseOutcome, GearRejectReason } from './gear/messages.ts';
export { GearActivationClient } from './gear/client.ts';
export type { ClientEvent, ConnectionHealth, GearClientState, LoadedSlot } from './gear/client.ts';
export { Hello, Chunk, PauseStart, PauseEnd, GameOver, Ping, ClientMessage, EndReason } from './flight/messages.ts';
export type { ServerMessage } from './flight/messages.ts';
