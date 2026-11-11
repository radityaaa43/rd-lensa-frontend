import { IStateBase, IStateEncoded } from "./interfaces";
export declare function encodeHex(data: string): string;
export declare function decodeHex(data: string): string;
export declare function newTransactionId(): string;
export declare const encodeStates: (states: IStateBase[]) => IStateEncoded[];
