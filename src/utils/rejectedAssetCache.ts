/**
 * Cache en mémoire des assets rejetés pour cause de prix trop élevé (ask >= MAX_BUY_PRICE).
 * Évite de retraiter le même marché plusieurs fois (plusieurs traders ou restart).
 * TTL : 10 minutes — laisse le temps au marché de revenir à un prix acceptable.
 */

const REJECTION_TTL_MS = 10 * 60 * 1000; // 10 minutes

const cache = new Map<string, number>(); // asset → timestamp du rejet

export function rejectAsset(asset: string): void {
    cache.set(asset, Date.now());
}

export function isAssetRejected(asset: string): boolean {
    const ts = cache.get(asset);
    if (!ts) return false;
    if (Date.now() - ts > REJECTION_TTL_MS) {
        cache.delete(asset);
        return false;
    }
    return true;
}
