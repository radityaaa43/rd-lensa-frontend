// Bind host of the HTTP server. Loopback unless HOST says otherwise: the host service stays reachable only through ssh -L,
// the pod sets HOST=0.0.0.0 so its Service can reach it (final-design/lensa/PLAN.md S2).
export const bindHost = (env: Record<string, string | undefined>): string => env.HOST || '127.0.0.1';
