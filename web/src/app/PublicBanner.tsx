import type { Meta } from '../api.ts';

// R24: the public host shows, on every page, that this is sandbox / exploration data on a public site. /api/meta carries `public: true` only there.
export function PublicBanner({ meta }: { meta: Meta }) {
  if (!meta.public) return null;
  return <div className="public-banner" role="note">Data sandbox / eksplorasi, situs publik{meta.publicTx ? ', transaksi uji tanpa kata sandi' : ''}</div>;
}
