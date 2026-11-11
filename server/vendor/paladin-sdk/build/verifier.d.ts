import { Algorithms, Verifiers } from "./interfaces";
import PaladinClient from "./paladin";
export declare class PaladinVerifier {
    private paladin;
    readonly lookup: string;
    constructor(paladin: PaladinClient, lookup: string);
    toString(): string;
    split(): {
        0: string;
        1: string;
        identity: string;
        node: string;
    };
    resolve(algorithm: Algorithms, verifierType: Verifiers): Promise<any>;
    address(): Promise<any>;
}
