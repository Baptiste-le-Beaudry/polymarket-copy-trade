import { ethers } from 'ethers';
import { ENV } from '../config/env';

const RPC_URL = ENV.RPC_URL;
const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Réseau Polygon défini explicitement → évite l'appel eth_chainId/net_version
// au démarrage qui provoque "could not detect network" si le RPC est rate-limité
const POLYGON_NETWORK = { chainId: 137, name: 'matic' };

// Provider singleton — évite de créer une nouvelle connexion à chaque trade
let _provider: ethers.providers.JsonRpcProvider | null = null;
const getProvider = (): ethers.providers.JsonRpcProvider => {
    if (!_provider) {
        _provider = new ethers.providers.JsonRpcProvider(RPC_URL, POLYGON_NETWORK);
    }
    return _provider;
};

const getMyBalance = async (address: string): Promise<number> => {
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, getProvider());
    const balance_usdc = await usdcContract.balanceOf(address);
    const balance_usdc_real = ethers.utils.formatUnits(balance_usdc, 6);
    return parseFloat(balance_usdc_real);
};

export default getMyBalance;
