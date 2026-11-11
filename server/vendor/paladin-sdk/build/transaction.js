"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionFuture = void 0;
// Represents an in-flight transaction
class TransactionFuture {
    constructor(paladin, id) {
        this.paladin = paladin;
        this.id = id;
    }
    toString() {
        return this.id;
    }
    async waitForReceipt(waitMs = 5000, full = false) {
        return this.paladin.pollForReceipt(await this.id, waitMs, full);
    }
}
exports.TransactionFuture = TransactionFuture;
