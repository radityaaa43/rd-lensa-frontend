"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaladinVerifier = void 0;
const interfaces_1 = require("./interfaces");
class PaladinVerifier {
    constructor(paladin, lookup) {
        this.paladin = paladin;
        this.lookup = lookup;
    }
    toString() {
        return this.lookup;
    }
    split() {
        const [identity, node] = this.lookup.split("@");
        return { 0: identity, 1: node, identity, node };
    }
    resolve(algorithm, verifierType) {
        return this.paladin.ptx.resolveVerifier(this.lookup, algorithm, verifierType);
    }
    address() {
        return this.resolve(interfaces_1.Algorithms.ECDSA_SECP256K1, interfaces_1.Verifiers.ETH_ADDRESS);
    }
}
exports.PaladinVerifier = PaladinVerifier;
