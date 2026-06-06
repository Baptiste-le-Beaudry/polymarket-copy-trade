import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

class Logger {
    private static logsDir = path.join(process.cwd(), 'logs');
    private static readonly LOG_FILE = path.join(process.cwd(), 'logs', 'bot.log');
    // When true, only allow logs that match the allowedPattern to be printed
    private static filterOnlyOrderLog = process.env.ONLY_SHOW_ORDER_LOG === 'true';
    private static allowedPattern = /signedOrderSignatureType/;

    // Rolling log settings
    private static readonly MAX_LOG_LINES = 5000;      // keep last 5000 lines
    private static readonly TRIM_INTERVAL = 250;       // check size every 250 writes
    private static writeCount = 0;

    /**
     * Call once at bot startup: clears the log file so each session starts fresh.
     */
    static initLogFile(): void {
        try {
            this.ensureLogsDir();
            const now = new Date().toISOString();
            fs.writeFileSync(
                this.LOG_FILE,
                `[${now}] ========== BOT STARTED ==========\n`,
                'utf8'
            );
            this.writeCount = 0;
        } catch {
            // Silently fail
        }
    }

    private static ensureLogsDir(): void {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    /**
     * Trim the log file to the last MAX_LOG_LINES lines.
     * Called every TRIM_INTERVAL writes to avoid reading the file too often.
     */
    private static trimLogFile(): void {
        try {
            if (!fs.existsSync(this.LOG_FILE)) return;
            const content = fs.readFileSync(this.LOG_FILE, 'utf8');
            const lines = content.split('\n');
            if (lines.length > this.MAX_LOG_LINES + 100) {
                // Keep last MAX_LOG_LINES lines
                const trimmed = lines.slice(-this.MAX_LOG_LINES);
                fs.writeFileSync(this.LOG_FILE, trimmed.join('\n'), 'utf8');
            }
        } catch {
            // Silently fail
        }
    }

    private static writeToFile(message: string): void {
        try {
            this.ensureLogsDir();
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] ${message}\n`;
            fs.appendFileSync(this.LOG_FILE, logEntry, 'utf8');

            this.writeCount++;
            if (this.writeCount % this.TRIM_INTERVAL === 0) {
                this.trimLogFile();
            }
        } catch {
            // Silently fail to avoid infinite loops
        }
    }

    private static stripAnsi(str: string): string {
        // Remove ANSI color codes for file logging
        return str.replace(/\u001b\[\d+m/g, '');
    }

    private static formatAddress(address: string): string {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    private static maskAddress(address: string): string {
        // Show 0x and first 4 chars, mask middle, show last 4 chars
        return `${address.slice(0, 6)}${'*'.repeat(34)}${address.slice(-4)}`;
    }

    static header(title: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(title)) return;
        console.log('\n' + chalk.cyan('━'.repeat(70)));
        console.log(chalk.cyan.bold(`  ${title}`));
        console.log(chalk.cyan('━'.repeat(70)) + '\n');
        this.writeToFile(`HEADER: ${title}`);
    }

    static info(message: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(message)) return;
        console.log(chalk.blue('ℹ'), message);
        this.writeToFile(`INFO: ${message}`);
    }

    static success(message: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(message)) return;
        console.log(chalk.green('✓'), message);
        this.writeToFile(`SUCCESS: ${message}`);
    }

    static warning(message: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(message)) return;
        console.log(chalk.yellow('⚠'), message);
        this.writeToFile(`WARNING: ${message}`);
    }

    static error(message: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(message)) return;
        console.log(chalk.red('✗'), message);
        this.writeToFile(`ERROR: ${message}`);
    }

    static trade(traderAddress: string, action: string, details: any) {
        const combined = `${traderAddress} ${action} ${JSON.stringify(details)}`;
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(combined)) return;
        console.log('\n' + chalk.magenta('─'.repeat(70)));
        console.log(chalk.magenta.bold('📊 NEW TRADE DETECTED'));
        console.log(chalk.gray(`Trader: ${this.formatAddress(traderAddress)}`));
        console.log(chalk.gray(`Action: ${chalk.white.bold(action)}`));
        if (details.asset) {
            console.log(chalk.gray(`Asset:  ${this.formatAddress(details.asset)}`));
        }
        if (details.side) {
            const sideColor = details.side === 'BUY' ? chalk.green : chalk.red;
            console.log(chalk.gray(`Side:   ${sideColor.bold(details.side)}`));
        }
        if (details.amount) {
            console.log(chalk.gray(`Amount: ${chalk.yellow(`$${details.amount}`)}`));
        }
        if (details.price) {
            console.log(chalk.gray(`Price:  ${chalk.cyan(details.price)}`));
        }
        if (details.eventSlug || details.slug) {
            // Use eventSlug for the correct market URL format
            const slug = details.eventSlug || details.slug;
            const marketUrl = `https://polymarket.com/event/${slug}`;
            console.log(chalk.gray(`Market: ${chalk.blue.underline(marketUrl)}`));
        }
        if (details.transactionHash) {
            const txUrl = `https://polygonscan.com/tx/${details.transactionHash}`;
            console.log(chalk.gray(`TX:     ${chalk.blue.underline(txUrl)}`));
        }
        console.log(chalk.magenta('─'.repeat(70)) + '\n');

        // Log to file
        let tradeLog = `TRADE: ${this.formatAddress(traderAddress)} - ${action}`;
        if (details.side) tradeLog += ` | Side: ${details.side}`;
        if (details.amount) tradeLog += ` | Amount: $${details.amount}`;
        if (details.price) tradeLog += ` | Price: ${details.price}`;
        if (details.title) tradeLog += ` | Market: ${details.title}`;
        if (details.transactionHash) tradeLog += ` | TX: ${details.transactionHash}`;
        this.writeToFile(tradeLog);
    }

    static balance(myBalance: number, traderBalance: number, traderAddress: string) {
        console.log(chalk.gray('Capital (USDC + Positions):'));
        console.log(
            chalk.gray(`  Your total capital:   ${chalk.green.bold(`$${myBalance.toFixed(2)}`)}`)
        );
        console.log(
            chalk.gray(
                `  Trader total capital: ${chalk.blue.bold(`$${traderBalance.toFixed(2)}`)} (${this.formatAddress(traderAddress)})`
            )
        );
    }

    static orderResult(success: boolean, message: string) {
        if (this.filterOnlyOrderLog && !this.allowedPattern.test(message)) return;
        if (success) {
            console.log(chalk.green('✓'), chalk.green.bold('Order executed:'), message);
            this.writeToFile(`ORDER SUCCESS: ${message}`);
        } else {
            console.log(chalk.red('✗'), chalk.red.bold('Order failed:'), message);
            this.writeToFile(`ORDER FAILED: ${message}`);
        }
    }

    static monitoring(traderCount: number) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(
            chalk.dim(`[${timestamp}]`),
            chalk.cyan('👁️  Monitoring'),
            chalk.yellow(`${traderCount} trader(s)`)
        );
    }

    static startup(traders: string[], myWallet: string) {
        console.log('\n');
        // ASCII Art Logo with gradient colors
        console.log(chalk.cyan('  ____       _        ____                 '));
        console.log(chalk.cyan(' |  _ \\ ___ | |_   _ / ___|___  _ __  _   _ '));
        console.log(chalk.cyan.bold(" | |_) / _ \\| | | | | |   / _ \\| '_ \\| | | |"));
        console.log(chalk.magenta.bold(' |  __/ (_) | | |_| | |__| (_) | |_) | |_| |'));
        console.log(chalk.magenta(' |_|   \\___/|_|\\__, |\\____\\___/| .__/ \\__, |'));
        console.log(chalk.magenta('               |___/            |_|    |___/ '));
        console.log(chalk.gray('               Copy the best, automate success\n'));

        console.log(chalk.cyan('━'.repeat(70)));
        console.log(chalk.cyan(`📊 Traders suivis: ${chalk.yellow.bold(`${traders.length} adresse(s)`)}`));
        // Afficher seulement les 3 premières adresses
        const maxShow = 3;
        traders.slice(0, maxShow).forEach((address, index) => {
            console.log(chalk.gray(`   ${index + 1}. ${address}`));
        });
        if (traders.length > maxShow) {
            console.log(chalk.gray(`   ... et ${traders.length - maxShow} autre(s)`));
        }
        console.log(chalk.cyan(`\n💼 Your Wallet:`));
        console.log(chalk.gray(`   ${this.maskAddress(myWallet)}\n`));
    }

    static dbConnection(traders: string[], counts: number[]) {
        const total = counts.reduce((sum, c) => sum + c, 0);
        console.log('\n' + chalk.cyan('📦 Database Status:'));
        console.log(chalk.gray(`   ${traders.length} trader(s) — ${chalk.yellow(`${total.toLocaleString()} trades`)} au total`));
        console.log('');
    }

    static separator() {
        console.log(chalk.dim('─'.repeat(70)));
    }

    private static spinnerFrames = ['⏳', '⌛', '⏳'];
    private static spinnerIndex = 0;

    static waiting(traderCount: number, extraInfo?: string) {
        const timestamp = new Date().toLocaleTimeString();
        const spinner = this.spinnerFrames[this.spinnerIndex % this.spinnerFrames.length];
        this.spinnerIndex++;

        const message = extraInfo
            ? `${spinner} Waiting for trades from ${traderCount} trader(s)... (${extraInfo})`
            : `${spinner} Waiting for trades from ${traderCount} trader(s)...`;

        process.stdout.write(chalk.dim(`\r[${timestamp}] `) + chalk.cyan(message) + '  ');
    }

    static clearLine() {
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
    }

    static myPositions(
        wallet: string,
        count: number,
        topPositions: any[],
        overallPnl: number,
        totalValue: number,
        initialValue: number,
        currentBalance: number
    ) {
        console.log('\n' + chalk.magenta.bold('💼 YOUR POSITIONS'));
        console.log(chalk.gray(`   Wallet: ${this.formatAddress(wallet)}`));
        console.log('');

        // Show balance and portfolio overview
        const balanceStr = chalk.yellow.bold(`$${currentBalance.toFixed(2)}`);
        const totalPortfolio = currentBalance + totalValue;
        const portfolioStr = chalk.cyan.bold(`$${totalPortfolio.toFixed(2)}`);

        console.log(chalk.gray(`   💰 Available Cash:    ${balanceStr}`));
        console.log(chalk.gray(`   📊 Total Portfolio:   ${portfolioStr}`));

        if (count === 0) {
            console.log(chalk.gray(`\n   No open positions`));
        } else {
            const countStr = chalk.green(`${count} position${count > 1 ? 's' : ''}`);
            const pnlColor = overallPnl >= 0 ? chalk.green : chalk.red;
            const pnlSign = overallPnl >= 0 ? '+' : '';
            const profitStr = pnlColor.bold(`${pnlSign}${overallPnl.toFixed(1)}%`);
            const valueStr = chalk.cyan(`$${totalValue.toFixed(2)}`);
            const initialStr = chalk.gray(`$${initialValue.toFixed(2)}`);

            console.log('');
            console.log(chalk.gray(`   📈 Open Positions:    ${countStr}`));
            console.log(chalk.gray(`      Invested:          ${initialStr}`));
            console.log(chalk.gray(`      Current Value:     ${valueStr}`));
            console.log(chalk.gray(`      Profit/Loss:       ${profitStr}`));

            // Show top positions
            if (topPositions.length > 0) {
                console.log(chalk.gray(`\n   🔝 Top Positions:`));
                topPositions.forEach((pos: any) => {
                    const pnlColor = pos.percentPnl >= 0 ? chalk.green : chalk.red;
                    const pnlSign = pos.percentPnl >= 0 ? '+' : '';
                    const avgPrice = pos.avgPrice || 0;
                    const curPrice = pos.curPrice || 0;
                    console.log(
                        chalk.gray(
                            `      • ${pos.outcome} - ${pos.title.slice(0, 45)}${pos.title.length > 45 ? '...' : ''}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        Value: ${chalk.cyan(`$${pos.currentValue.toFixed(2)}`)} | PnL: ${pnlColor(`${pnlSign}${pos.percentPnl.toFixed(1)}%`)}`
                        )
                    );
                    console.log(
                        chalk.gray(
                            `        Bought @ ${chalk.yellow(`${(avgPrice * 100).toFixed(1)}¢`)} | Current @ ${chalk.yellow(`${(curPrice * 100).toFixed(1)}¢`)}`
                        )
                    );
                });
            }
        }
        console.log('');
    }

    static tradersPositions(
        traders: string[],
        positionCounts: number[],
        positionDetails?: any[][],
        profitabilities?: number[]
    ) {
        console.log('\n' + chalk.cyan("📈 TRADERS YOU'RE COPYING"));
        traders.forEach((address, index) => {
            const count = positionCounts[index];
            const countStr =
                count > 0
                    ? chalk.green(`${count} position${count > 1 ? 's' : ''}`)
                    : chalk.gray('0 positions');

            // Add profitability if available
            let profitStr = '';
            if (profitabilities && profitabilities[index] !== undefined && count > 0) {
                const pnl = profitabilities[index];
                const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
                const pnlSign = pnl >= 0 ? '+' : '';
                profitStr = ` | ${pnlColor.bold(`${pnlSign}${pnl.toFixed(1)}%`)}`;
            }

            console.log(chalk.gray(`   ${this.formatAddress(address)}: ${countStr}${profitStr}`));
        });
        console.log('');
    }
}

export default Logger;
