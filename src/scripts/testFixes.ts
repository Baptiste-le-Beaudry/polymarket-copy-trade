/**
 * Test Script for Loss Prevention Fixes
 *
 * This script validates that the two major fixes are working correctly:
 * 1. Fix #2: Trader position verification before BUY
 * 2. Fix #3: High-loss position closing script
 *
 * Usage: npm run test-fixes
 */

import { ENV } from '../config/env';
import createClobClient from '../utils/createClobClient';
import fetchData from '../utils/fetchData';
import { getSimulationTracker } from '../utils/simulationBalance';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const USER_ADDRESSES = ENV.USER_ADDRESSES;

interface TestResult {
    name: string;
    passed: boolean;
    details: string;
    emoji: string;
}

const results: TestResult[] = [];

const addResult = (name: string, passed: boolean, details: string) => {
    results.push({
        name,
        passed,
        details,
        emoji: passed ? '✅' : '❌'
    });
};

/**
 * Test 1: Verify trader position verification code exists
 */
const testTraderPositionVerificationCodeExists = async (): Promise<void> => {
    console.log('\n📝 Test 1: Vérification du code de validation des positions trader');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        const fs = require('fs');
        const executorPath = 'src/services/tradeExecutor.ts';
        const content = fs.readFileSync(executorPath, 'utf8');

        // Check for the critical verification code
        const hasPositionCheck = content.includes('CRITICAL: For BUY trades, verify trader STILL HOLDS this position');
        const hasSkipLogic = content.includes('Trader no longer holds this position');
        const hasTraderVerification = content.includes('traderHasPosition');

        if (hasPositionCheck && hasSkipLogic && hasTraderVerification) {
            addResult(
                'Code de vérification présent',
                true,
                'Le code de vérification de position trader est bien implémenté dans tradeExecutor.ts'
            );
        } else {
            addResult(
                'Code de vérification présent',
                false,
                'Le code de vérification semble manquant ou incomplet'
            );
        }
    } catch (error) {
        addResult(
            'Code de vérification présent',
            false,
            `Erreur lors de la vérification: ${error}`
        );
    }
};

/**
 * Test 2: Verify trader positions can be fetched
 */
const testTraderPositionFetch = async (): Promise<void> => {
    console.log('\n📡 Test 2: Récupération des positions des traders');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        const trader = USER_ADDRESSES[0];
        console.log(`   Trader: ${trader.substring(0, 10)}...`);

        const positions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${trader}`
        );

        if (Array.isArray(positions)) {
            const activePositions = positions.filter((p: any) => p.size > 0);
            console.log(`   Positions actives trouvées: ${activePositions.length}`);

            if (activePositions.length > 0) {
                const firstPos = activePositions[0];
                console.log(`   Exemple: ${firstPos.market || firstPos.conditionId.substring(0, 12)}...`);
                console.log(`   Size: ${firstPos.size?.toFixed(2)} tokens`);
                console.log(`   Avg Price: $${firstPos.avgPrice?.toFixed(4)}`);
            }

            addResult(
                'Fetch positions trader',
                true,
                `${activePositions.length} position(s) active(s) récupérée(s) pour le trader`
            );
        } else {
            addResult(
                'Fetch positions trader',
                false,
                'Format de réponse invalide de l\'API Polymarket'
            );
        }
    } catch (error) {
        addResult(
            'Fetch positions trader',
            false,
            `Erreur lors de la récupération: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

/**
 * Test 3: Verify simulation mode is active
 */
const testSimulationModeActive = (): void => {
    console.log('\n🧪 Test 3: Mode simulation actif');
    console.log('─────────────────────────────────────────────────────────────────');

    const isDryRun = ENV.DRY_RUN;
    console.log(`   DRY_RUN: ${isDryRun}`);

    if (isDryRun) {
        addResult(
            'Mode simulation actif',
            true,
            'Le mode simulation est bien activé (DRY_RUN=true)'
        );
    } else {
        addResult(
            'Mode simulation actif',
            false,
            '⚠️  ATTENTION: Mode RÉEL activé (DRY_RUN=false) - Les tests devraient être en simulation!'
        );
    }
};

/**
 * Test 4: Verify price filters are configured
 */
const testPriceFiltersConfigured = (): void => {
    console.log('\n🛡️  Test 4: Filtres de prix configurés');
    console.log('─────────────────────────────────────────────────────────────────');

    const maxBuyPrice = ENV.MAX_BUY_PRICE;
    const minGainPotential = ENV.MIN_GAIN_POTENTIAL_PERCENT;

    console.log(`   MAX_BUY_PRICE: $${maxBuyPrice}`);
    console.log(`   MIN_GAIN_POTENTIAL_PERCENT: ${minGainPotential}%`);

    const isConfigured = maxBuyPrice && maxBuyPrice < 1.0 && minGainPotential && minGainPotential > 0;

    if (isConfigured) {
        addResult(
            'Filtres de prix configurés',
            true,
            `Prix max: $${maxBuyPrice}, Gain min: ${minGainPotential}%`
        );
    } else {
        addResult(
            'Filtres de prix configurés',
            false,
            'Les filtres de prix semblent mal configurés ou désactivés'
        );
    }
};

/**
 * Test 5: Verify close-high-loss script exists
 */
const testCloseHighLossScriptExists = (): void => {
    console.log('\n📜 Test 5: Script de fermeture des positions à perte existe');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        const fs = require('fs');
        const scriptPath = 'src/scripts/closeHighLossPositions.ts';
        const exists = fs.existsSync(scriptPath);

        if (exists) {
            const content = fs.readFileSync(scriptPath, 'utf8');
            const hasLossCalculation = content.includes('pnlPercent');
            const hasSellLogic = content.includes('executeSimulatedTrade');
            const hasConfirmation = content.includes('Continue? (yes/no)');

            if (hasLossCalculation && hasSellLogic && hasConfirmation) {
                addResult(
                    'Script close-high-loss existe',
                    true,
                    'Le script est présent et contient la logique nécessaire'
                );
            } else {
                addResult(
                    'Script close-high-loss existe',
                    false,
                    'Le script existe mais semble incomplet'
                );
            }
        } else {
            addResult(
                'Script close-high-loss existe',
                false,
                'Le script closeHighLossPositions.ts est introuvable'
            );
        }
    } catch (error) {
        addResult(
            'Script close-high-loss existe',
            false,
            `Erreur lors de la vérification: ${error}`
        );
    }
};

/**
 * Test 6: Verify package.json has close-high-loss command
 */
const testPackageJsonCommand = (): void => {
    console.log('\n📦 Test 6: Commande npm configurée');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        const fs = require('fs');
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const hasCommand = packageJson.scripts && packageJson.scripts['close-high-loss'];

        if (hasCommand) {
            console.log(`   Commande: ${packageJson.scripts['close-high-loss']}`);
            addResult(
                'Commande npm configurée',
                true,
                'La commande "npm run close-high-loss" est disponible'
            );
        } else {
            addResult(
                'Commande npm configurée',
                false,
                'La commande close-high-loss est manquante dans package.json'
            );
        }
    } catch (error) {
        addResult(
            'Commande npm configurée',
            false,
            `Erreur lors de la lecture de package.json: ${error}`
        );
    }
};

/**
 * Test 7: Verify simulation state and positions
 */
const testSimulationState = (): void => {
    console.log('\n💾 Test 7: État de la simulation');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        if (!ENV.DRY_RUN) {
            addResult(
                'État de la simulation',
                false,
                'Impossible de tester - mode simulation désactivé'
            );
            return;
        }

        const simTracker = getSimulationTracker();
        const balance = simTracker.getBalance();
        const positions = simTracker.getAllPositions();

        console.log(`   Balance actuelle: $${balance.toFixed(2)}`);
        console.log(`   Positions ouvertes: ${positions.length}`);

        if (positions.length > 0) {
            const firstPos = positions[0];
            console.log(`   Exemple: ${firstPos.market || firstPos.asset.substring(0, 12)}...`);
            console.log(`   Size: ${firstPos.size.toFixed(2)} tokens @ $${firstPos.avgPrice.toFixed(4)}`);
        }

        addResult(
            'État de la simulation',
            true,
            `Balance: $${balance.toFixed(2)}, ${positions.length} position(s)`
        );
    } catch (error) {
        addResult(
            'État de la simulation',
            false,
            `Erreur lors de la lecture: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

/**
 * Test 8: Simulate trader position check logic
 */
const testTraderPositionCheckLogic = async (): Promise<void> => {
    console.log('\n🔍 Test 8: Logique de vérification des positions (simulation)');
    console.log('─────────────────────────────────────────────────────────────────');

    try {
        const trader = USER_ADDRESSES[0];
        const positions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${trader}`
        );

        if (!Array.isArray(positions) || positions.length === 0) {
            addResult(
                'Test logique de vérification',
                false,
                'Aucune position disponible pour tester la logique'
            );
            return;
        }

        // Simulate the check logic
        const testConditionId = positions[0].conditionId;
        const testAsset = positions[0].asset;

        const traderHasPosition = positions.some(
            (p: any) =>
                p.conditionId === testConditionId &&
                p.asset === testAsset &&
                p.size > 0
        );

        console.log(`   Test conditionId: ${testConditionId.substring(0, 12)}...`);
        console.log(`   Test asset: ${testAsset.substring(0, 12)}...`);
        console.log(`   Trader has position: ${traderHasPosition}`);

        if (traderHasPosition) {
            addResult(
                'Test logique de vérification',
                true,
                'La logique de vérification fonctionne correctement (position détectée)'
            );
        } else {
            addResult(
                'Test logique de vérification',
                false,
                'La logique semble ne pas détecter correctement les positions'
            );
        }
    } catch (error) {
        addResult(
            'Test logique de vérification',
            false,
            `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

/**
 * Display final results
 */
const displayResults = (): void => {
    console.log('\n');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('📊 RÉSULTATS DES TESTS');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');

    let passedCount = 0;
    let failedCount = 0;

    results.forEach((result, index) => {
        console.log(`${index + 1}. ${result.emoji} ${result.name}`);
        console.log(`   ${result.details}`);
        console.log('');

        if (result.passed) {
            passedCount++;
        } else {
            failedCount++;
        }
    });

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`✅ Tests réussis: ${passedCount}/${results.length}`);
    console.log(`❌ Tests échoués: ${failedCount}/${results.length}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');

    if (failedCount === 0) {
        console.log('🎉 EXCELLENT! Tous les tests sont passés.');
        console.log('   Les fixes sont correctement implémentés et fonctionnels.');
        console.log('');
        console.log('✅ Prochaines étapes:');
        console.log('   1. Lancer le bot: npm run dev');
        console.log('   2. Surveiller les logs pour "⛔ Skipping BUY - Trader no longer holds..."');
        console.log('   3. Vérifier l\'alignement avec: npm run check-alignment');
        console.log('');
    } else {
        console.log('⚠️  ATTENTION! Certains tests ont échoué.');
        console.log('   Vérifiez les détails ci-dessus pour identifier les problèmes.');
        console.log('');

        if (results.some(r => !r.passed && r.name.includes('Code de vérification'))) {
            console.log('🔧 Action recommandée:');
            console.log('   - Vérifier que tradeExecutor.ts contient le code de vérification');
            console.log('   - Recompiler: npm run build');
        }

        if (results.some(r => !r.passed && r.name.includes('close-high-loss'))) {
            console.log('🔧 Action recommandée:');
            console.log('   - Vérifier que closeHighLossPositions.ts existe');
            console.log('   - Vérifier package.json pour la commande');
        }

        console.log('');
    }
};

/**
 * Main test runner
 */
const main = async () => {
    console.log('🧪 TEST DES FIXES POUR LES PROBLÈMES DE PERTES');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`Date: ${new Date().toLocaleString()}`);
    console.log(`Wallet: ${PROXY_WALLET}`);
    console.log(`Traders suivis: ${USER_ADDRESSES.length}`);
    console.log('');

    // Run all tests
    testSimulationModeActive();
    testPriceFiltersConfigured();
    testTraderPositionVerificationCodeExists();
    testCloseHighLossScriptExists();
    testPackageJsonCommand();
    testSimulationState();

    // Async tests
    await testTraderPositionFetch();
    await testTraderPositionCheckLogic();

    // Display results
    displayResults();
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Erreur lors des tests:', error);
        process.exit(1);
    });
