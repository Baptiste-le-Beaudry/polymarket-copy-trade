/**
 * openaiClassify.ts
 *
 * Envoie le profil d'un trader à OpenAI (gpt-4o-mini) pour déterminer :
 * - POSITIONAL : achète à prix bas, tient des jours/semaines → COPIABLE ✅
 * - NEWS_TRADER : achète juste avant résolution du marché → NON COPIABLE ❌
 * - MIXED : mélange des deux → PARTIELLEMENT COPIABLE ⚠️
 *
 * Coût estimé : ~$0.0002 par trader (gpt-4o-mini)
 */

import OpenAI from 'openai';

// ─── Types exportés ───────────────────────────────────────────────────────────

export interface TraderProfile {
    address: string;
    pseudonym: string;
    avgBuyPrice: number;
    pctBuysUnder070: number;       // % de BUY avec prix < $0.70
    pctFastResolution: number;     // % de marchés résolus dans les 2h après l'achat
    avgHoursToResolution: number;  // durée moyenne entre achat et résolution
    uniqueMarkets: number;
    tradeCount: number;
    realizedPnl: number;
    openPnl: number;
    recentBuys: Array<{
        price: number;
        market: string;
        timestamp: number;
        hoursToResolution: number | null;  // null = non résolu encore
    }>;
}

export type Classification = 'POSITIONAL' | 'NEWS_TRADER' | 'MIXED';

export interface OpenAIVerdict {
    classification: Classification;
    copyable: boolean;
    confidence: number;    // 0-10
    reasoning: string;     // explication courte en français
}

// ─── Fallback heuristique (si pas de clé OpenAI) ─────────────────────────────

export const heuristicClassify = (profile: TraderProfile): OpenAIVerdict => {
    // News trader si : avg price élevé OU beaucoup de résolutions rapides
    const isNewsTrader =
        profile.avgBuyPrice > 0.65 ||
        profile.pctFastResolution > 0.50 ||
        (profile.avgBuyPrice > 0.55 && profile.pctFastResolution > 0.30);

    // Clairement positionnel : prix bas + peu de résolutions rapides
    const isPositional =
        profile.avgBuyPrice < 0.40 &&
        profile.pctFastResolution < 0.20 &&
        profile.pctBuysUnder070 > 0.70;

    if (isNewsTrader) {
        return {
            classification: 'NEWS_TRADER',
            copyable: false,
            confidence: 7,
            reasoning: `Prix moyen $${profile.avgBuyPrice.toFixed(2)} et ${(profile.pctFastResolution * 100).toFixed(0)}% de marchés résolus en <2h — pattern news trading.`,
        };
    }

    if (isPositional) {
        return {
            classification: 'POSITIONAL',
            copyable: true,
            confidence: 7,
            reasoning: `Prix moyen $${profile.avgBuyPrice.toFixed(2)}, ${(profile.pctBuysUnder070 * 100).toFixed(0)}% sous $0.70, peu de résolutions rapides — pattern positionnel.`,
        };
    }

    return {
        classification: 'MIXED',
        copyable: profile.avgBuyPrice < 0.55,
        confidence: 4,
        reasoning: `Profil mixte — prix moyen $${profile.avgBuyPrice.toFixed(2)}, ${(profile.pctFastResolution * 100).toFixed(0)}% résolutions rapides.`,
    };
};

// ─── Analyse OpenAI ───────────────────────────────────────────────────────────

let _openaiClient: OpenAI | null = null;

const getClient = (): OpenAI => {
    if (!_openaiClient) {
        _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _openaiClient;
};

export const classifyWithOpenAI = async (profile: TraderProfile): Promise<OpenAIVerdict> => {
    // Échantillon des trades pour le prompt
    const buySample = profile.recentBuys
        .slice(0, 12)
        .map(b => {
            const date = new Date(b.timestamp * 1000).toISOString().slice(0, 10);
            const resolution =
                b.hoursToResolution === null
                    ? 'non résolu encore'
                    : b.hoursToResolution < 2
                        ? `⚡ résolu en ${b.hoursToResolution.toFixed(1)}h`
                        : b.hoursToResolution < 24
                            ? `résolu en ${b.hoursToResolution.toFixed(0)}h`
                            : `résolu en ${(b.hoursToResolution / 24).toFixed(1)} jours`;
            return `  - $${b.price.toFixed(3)} @ ${date} | ${b.market} | ${resolution}`;
        })
        .join('\n');

    const prompt = `Tu analyses un trader Polymarket pour déterminer si sa stratégie est compatible avec le copy trading automatisé (délai de copie : 5-30 secondes).

MÉTRIQUES (30 derniers jours) :
- Prix d'achat moyen : $${profile.avgBuyPrice.toFixed(3)}
- % trades sous $0.70 : ${(profile.pctBuysUnder070 * 100).toFixed(0)}%
- % marchés résolus dans les 2h après l'achat : ${(profile.pctFastResolution * 100).toFixed(0)}%
- Durée moyenne jusqu'à résolution : ${profile.avgHoursToResolution.toFixed(1)}h
- Marchés uniques tradés : ${profile.uniqueMarkets}
- Nombre de trades total : ${profile.tradeCount}
- P&L réalisé : $${profile.realizedPnl.toFixed(0)}
- P&L positions ouvertes : $${profile.openPnl.toFixed(0)}

ÉCHANTILLON DE TRADES BUY RÉCENTS :
${buySample}

RÈGLES D'ÉVALUATION :
- NEWS TRADER (❌ non copiable) : achète juste avant qu'un événement résout le marché. Le marché résout souvent en <2h. Prix d'entrée souvent > $0.60 déjà.
- POSITIONAL (✅ copiable) : achète à prix bas ($0.05-0.50), tient des jours ou semaines. Le marché a le temps d'évoluer après la copie.
- MIXED (⚠️ partiellement copiable) : mélange des deux stratégies.

Réponds UNIQUEMENT avec ce JSON valide (sans markdown, sans commentaires) :
{
  "classification": "POSITIONAL",
  "copyable": true,
  "confidence": 8,
  "reasoning": "explication en 1-2 phrases en français"
}`;

    try {
        const response = await getClient().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 200,
        });

        const raw = response.choices[0].message.content ?? '{}';

        // Extraire le JSON proprement (au cas où le modèle ajouterait du texte)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('JSON introuvable dans la réponse');

        const parsed = JSON.parse(jsonMatch[0]) as OpenAIVerdict;

        // Validation basique
        if (!['POSITIONAL', 'NEWS_TRADER', 'MIXED'].includes(parsed.classification)) {
            throw new Error(`Classification invalide: ${parsed.classification}`);
        }

        return parsed;

    } catch (err: any) {
        // Fallback heuristique si OpenAI échoue
        console.error(`\n   ⚠️  OpenAI erreur (${err.message?.slice(0, 60)}), fallback heuristique`);
        return heuristicClassify(profile);
    }
};
