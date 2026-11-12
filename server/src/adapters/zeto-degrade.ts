import { PARTIES, type PartyId } from '../domain.ts';
import { withDeadline } from '../deadline.ts';

// R21 (R2 live, 2026-11-12): Zeto settlement does not need BI. A Zeto write is gated on the sender's and receiver's nodes only; BI down degrades only the BI-dependent parts
// (the report to BI and BI's verification, BI's lens), which show "report pending" instead of failing a tx that already settled. Noto/Pente keep BI as notary (no readyFor).

// Are the Paladin nodes of `parties` answering? probe(party) resolves when that party's node answers. Down nodes are named by number, never by the raw error (it can carry a URL).
export async function nodesReady(probe: (p: PartyId) => Promise<unknown>, parties: PartyId[], budgetMs = 4_000): Promise<{ ready: boolean; detail: string }> {
  const results = await Promise.allSettled(parties.map((p) => withDeadline(Promise.resolve().then(() => probe(p)), budgetMs, `Node ${PARTIES[p].node}`)));
  const down = parties.filter((_, i) => results[i]!.status === 'rejected').map((p) => PARTIES[p].node).sort((a, b) => a - b);
  return down.length ? { ready: false, detail: `Node Paladin ${down.join(', ')} tidak menjawab` } : { ready: true, detail: `Node Paladin ${parties.map((p) => PARTIES[p].node).sort((a, b) => a - b).join(', ')} siap` };
}

export const REPORT_PENDING = 'Transaksi selesai. Laporan ke BI tertunda (node BI belum menjawab); BI memverifikasinya setelah node BI kembali.';

// After settlement: send the reports, then wait for BI to verify them. A failure of either is NOT a failure of the user's tx: it is logged and shown as "report pending".
export async function settleReports(send: () => Promise<void>, verify: () => Promise<void>): Promise<{ pending: string | undefined }> {
  try {
    await send();
    await verify();
    return { pending: undefined };
  } catch (e) {
    console.error('[zeto] laporan ke BI tertunda setelah penyelesaian:', e instanceof Error ? e.message : String(e));
    return { pending: REPORT_PENDING };
  }
}

// The tx's outputs are read from BI's own indexer; with BI down the sender's node (it indexes the same chain) answers instead.
export async function withIoFallback<T>(viaBi: () => Promise<T>, viaSender: () => Promise<T>): Promise<T> {
  try { return await viaBi(); } catch (e) {
    console.error('[zeto] node BI tidak terbaca, hasil tx dibaca dari node pengirim:', e instanceof Error ? e.message : String(e));
    return viaSender();
  }
}
