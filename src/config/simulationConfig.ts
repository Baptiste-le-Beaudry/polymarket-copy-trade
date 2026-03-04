/**
 * Configuration module for simulation modes and strategies
 */

export enum SimulationMode {
    SIMPLE = 'SIMPLE',       // Fixed slippage, no API calls, fast
    REALISTIC = 'REALISTIC', // Real order book, dynamic slippage, full handling
    HYBRID = 'HYBRID'        // Real order book with fallback to SIMPLE on API errors
}

export enum PartialFillStrategy {
    WARN = 'WARN',       // Accept partial fill, log warning
    PARTIAL = 'PARTIAL', // Accept partial fill, adjust position size
    ABORT = 'ABORT'      // Abort entire trade if not fully filled
}

export interface SimulationConfig {
    mode: SimulationMode;
    maxSlippagePercent: number;
    partialFillStrategy: PartialFillStrategy;
}

/**
 * Parse and validate simulation mode from environment variable
 */
export function parseSimulationMode(value: string | undefined): SimulationMode {
    if (!value) {
        return SimulationMode.HYBRID; // Default to HYBRID
    }

    const normalized = value.toUpperCase();

    if (normalized === 'SIMPLE') return SimulationMode.SIMPLE;
    if (normalized === 'REALISTIC') return SimulationMode.REALISTIC;
    if (normalized === 'HYBRID') return SimulationMode.HYBRID;

    console.warn(`Invalid SIMULATION_MODE: ${value}. Defaulting to HYBRID.`);
    return SimulationMode.HYBRID;
}

/**
 * Parse and validate partial fill strategy from environment variable
 */
export function parsePartialFillStrategy(value: string | undefined): PartialFillStrategy {
    if (!value) {
        return PartialFillStrategy.WARN; // Default to WARN
    }

    const normalized = value.toUpperCase();

    if (normalized === 'WARN') return PartialFillStrategy.WARN;
    if (normalized === 'PARTIAL') return PartialFillStrategy.PARTIAL;
    if (normalized === 'ABORT') return PartialFillStrategy.ABORT;

    console.warn(`Invalid SIMULATION_PARTIAL_FILL_STRATEGY: ${value}. Defaulting to WARN.`);
    return PartialFillStrategy.WARN;
}

/**
 * Get simulation configuration from environment variables
 */
export function getSimulationConfig(): SimulationConfig {
    const mode = parseSimulationMode(process.env.SIMULATION_MODE);
    const maxSlippagePercent = parseFloat(process.env.SIMULATION_MAX_SLIPPAGE_PERCENT || '5.0');
    const partialFillStrategy = parsePartialFillStrategy(process.env.SIMULATION_PARTIAL_FILL_STRATEGY);

    // Validate maxSlippagePercent
    if (isNaN(maxSlippagePercent) || maxSlippagePercent < 0 || maxSlippagePercent > 100) {
        console.warn(`Invalid SIMULATION_MAX_SLIPPAGE_PERCENT: ${process.env.SIMULATION_MAX_SLIPPAGE_PERCENT}. Defaulting to 5.0%.`);
        return {
            mode,
            maxSlippagePercent: 5.0,
            partialFillStrategy
        };
    }

    return {
        mode,
        maxSlippagePercent,
        partialFillStrategy
    };
}
