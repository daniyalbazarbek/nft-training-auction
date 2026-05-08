import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { CONTRACT_ABI } from "./contractAbi.js";
import "./App.css";

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || "";
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const SEPOLIA_CHAIN_ID_DECIMAL = 11155111;

const initialSpotForm = {
  coachName: "",
  trainingDateTime: "",
  description: "",
  location: "",
  imageURI: "",
  metadataURI: "",
};

function sameAddress(a, b) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function shortAddress(address) {
  if (!address || address === ethers.ZeroAddress) {
    return "No bidder yet";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatEth(value) {
  const eth = ethers.formatEther(value || "0");
  const numeric = Number(eth);

  if (!Number.isFinite(numeric)) {
    return `${eth} ETH`;
  }

  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 5 })} ETH`;
}

function ipfsToHttp(uri) {
  if (!uri) {
    return "";
  }

  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  }

  return uri;
}

function getErrorMessage(error) {
  return error?.shortMessage || error?.reason || error?.message || "Transaction failed";
}

function formatTimeLeft(seconds) {
  if (!seconds) {
    return "Ready for first bid";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return `${hours}h ${minutes}m left before auto-close`;
}

export default function App() {
  const [account, setAccount] = useState("");
  const [networkOk, setNetworkOk] = useState(false);
  const [contractOwner, setContractOwner] = useState("");
  const [spots, setSpots] = useState([]);
  const [bidAmounts, setBidAmounts] = useState({});
  const [pendingRefund, setPendingRefund] = useState("0");
  const [sellerBalance, setSellerBalance] = useState("0");
  const [spotForm, setSpotForm] = useState(initialSpotForm);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const hasMetaMask = typeof window !== "undefined" && Boolean(window.ethereum);
  const contractReady = ethers.isAddress(CONTRACT_ADDRESS);
  const isOwner = sameAddress(account, contractOwner);

  useEffect(() => {
    if (!hasMetaMask) {
      return undefined;
    }

    async function boot() {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });

      setAccount(accounts[0] || "");
      setNetworkOk(chainId.toLowerCase() === SEPOLIA_CHAIN_ID);
      await loadAuctions(accounts[0] || "");
    }

    function handleAccountsChanged(accounts) {
      const nextAccount = accounts[0] || "";
      setAccount(nextAccount);
      loadAuctions(nextAccount);
    }

    function handleChainChanged(chainId) {
      setNetworkOk(chainId.toLowerCase() === SEPOLIA_CHAIN_ID);
      loadAuctions(account);
    }

    boot().catch((error) => setStatus(getErrorMessage(error)));

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [hasMetaMask]);

  async function updateNetworkStatus() {
    if (!hasMetaMask) {
      setNetworkOk(false);
      return false;
    }

    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    const ok = chainId.toLowerCase() === SEPOLIA_CHAIN_ID;
    setNetworkOk(ok);

    return ok;
  }

  async function switchToSepolia() {
    if (!hasMetaMask) {
      setStatus("MetaMask is not installed.");
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID }],
      });
    } catch (error) {
      if (error.code !== 4902) {
        setStatus(getErrorMessage(error));
        return;
      }

      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: SEPOLIA_CHAIN_ID,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.sepolia.org"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }

    await updateNetworkStatus();
    await loadAuctions(account);
  }

  async function ensureSepolia() {
    if (await updateNetworkStatus()) {
      return;
    }

    await switchToSepolia();

    if (!(await updateNetworkStatus())) {
      throw new Error("Switch to Sepolia before sending transactions.");
    }
  }

  async function getContract(withSigner = false) {
    if (!contractReady) {
      throw new Error("Set VITE_CONTRACT_ADDRESS in .env after deployment.");
    }

    if (!hasMetaMask) {
      throw new Error("MetaMask is required.");
    }

    const provider = new ethers.BrowserProvider(window.ethereum);

    if (withSigner) {
      const signer = await provider.getSigner();
      return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    }

    return new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
  }

  async function connectWallet() {
    if (!hasMetaMask) {
      setStatus("Install MetaMask to use this dApp.");
      return;
    }

    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const nextAccount = accounts[0] || "";

      setAccount(nextAccount);
      await updateNetworkStatus();
      await loadAuctions(nextAccount);
      setStatus("Wallet connected.");
    } catch (error) {
      setStatus(getErrorMessage(error));
    }
  }

  function disconnectWallet() {
    setAccount("");
    setPendingRefund("0");
    setSellerBalance("0");
    setStatus("Wallet disconnected from this page.");
  }

  async function loadAuctions(activeAccount = account) {
    if (!contractReady || !hasMetaMask) {
      return;
    }

    setLoading(true);

    try {
      const contract = await getContract(false);
      const [ownerAddress, ids] = await Promise.all([contract.owner(), contract.getAuctionedTokenIds()]);

      setContractOwner(ownerAddress);

      const loadedSpots = await Promise.all(
        ids.map(async (id) => {
          const [spot, auction, expired, left] = await Promise.all([
            contract.spots(id),
            contract.auctions(id),
            contract.isAuctionExpired(id),
            contract.timeLeft(id),
          ]);

          return {
            tokenId: id.toString(),
            coachName: spot.coachName ?? spot[0],
            trainingDateTime: spot.trainingDateTime ?? spot[1],
            description: spot.description ?? spot[2],
            location: spot.location ?? spot[3],
            imageURI: spot.imageURI ?? spot[4],
            seller: spot.seller ?? spot[5],
            sold: spot.sold ?? spot[6],
            highestBid: auction.highestBid ?? auction[1],
            highestBidder: auction.highestBidder ?? auction[2],
            lastBidAt: Number(auction.lastBidAt ?? auction[3]),
            ended: auction.ended ?? auction[4],
            expired,
            timeLeft: Number(left),
          };
        })
      );

      setSpots(loadedSpots.reverse());

      if (activeAccount) {
        const [refund, proceeds] = await Promise.all([
          contract.pendingReturns(activeAccount),
          contract.sellerProceeds(activeAccount),
        ]);

        setPendingRefund(refund.toString());
        setSellerBalance(proceeds.toString());
      }
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function updateBidAmount(tokenId, value) {
    setBidAmounts((current) => ({ ...current, [tokenId]: value }));
  }

  function updateSpotForm(field, value) {
    setSpotForm((current) => ({ ...current, [field]: value }));
  }

  async function placeBid(tokenId) {
    if (!account) {
      await connectWallet();
      return;
    }

    const amount = bidAmounts[tokenId];

    if (!amount || Number(amount) <= 0) {
      setStatus("Enter a positive bid amount in ETH.");
      return;
    }

    try {
      await ensureSepolia();

      setBusyAction(`bid-${tokenId}`);
      setStatus("Sending bid transaction...");

      const contract = await getContract(true);
      const tx = await contract.placeBid(tokenId, { value: ethers.parseEther(amount) });

      await tx.wait();
      setBidAmounts((current) => ({ ...current, [tokenId]: "" }));
      setStatus("Bid placed successfully.");
      await loadAuctions(account);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function finalizeAuction(item) {
    if (!account) {
      await connectWallet();
      return;
    }

    try {
      await ensureSepolia();

      setBusyAction(`finalize-${item.tokenId}`);
      setStatus("Finalizing auction...");

      const contract = await getContract(true);
      const tx = item.expired
        ? await contract.finalizeExpiredAuction(item.tokenId)
        : await contract.endAuction(item.tokenId);

      await tx.wait();
      setStatus("Auction finalized. NFT ownership was transferred to the winner.");
      await loadAuctions(account);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function withdraw(kind) {
    try {
      await ensureSepolia();

      setBusyAction(kind);
      setStatus("Sending withdrawal transaction...");

      const contract = await getContract(true);
      const tx = kind === "refund" ? await contract.withdraw() : await contract.withdrawSellerProceeds();

      await tx.wait();
      setStatus("Withdrawal completed.");
      await loadAuctions(account);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  async function mintTrainingSpot(event) {
    event.preventDefault();

    const requiredFields = ["coachName", "trainingDateTime", "description", "location"];
    const missingField = requiredFields.find((field) => !spotForm[field].trim());

    if (missingField) {
      setStatus("Coach, date/time, description and location are required.");
      return;
    }

    try {
      await ensureSepolia();

      setBusyAction("mint");
      setStatus("Minting training spot NFT...");

      const contract = await getContract(true);
      const tx = await contract.mintTrainingSpot(
        spotForm.coachName.trim(),
        spotForm.trainingDateTime.trim(),
        spotForm.description.trim(),
        spotForm.location.trim(),
        spotForm.imageURI.trim(),
        spotForm.metadataURI.trim()
      );

      await tx.wait();
      setSpotForm(initialSpotForm);
      setStatus("Training spot minted and listed for auction.");
      await loadAuctions(account);
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  }

  const hasRefund = BigInt(pendingRefund || "0") > 0n;
  const hasProceeds = BigInt(sellerBalance || "0") > 0n;

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">ERC-721 Sepolia Auction</p>
          <h1>Premium Training Spots</h1>
          <p className="hero-copy">
            Bid for exclusive gym sessions with celebrity coaches. Each winning bidder receives the NFT that
            represents access to the selected training slot.
          </p>
        </div>

        <div className="wallet-card">
          <span className={networkOk ? "pill success" : "pill warning"}>
            {networkOk ? "Sepolia connected" : "Sepolia required"}
          </span>
          <strong>{account ? shortAddress(account) : "Wallet not connected"}</strong>
          <div className="wallet-actions">
            {account ? (
              <button className="secondary" type="button" onClick={disconnectWallet}>
                Disconnect
              </button>
            ) : (
              <button type="button" onClick={connectWallet}>
                Connect MetaMask
              </button>
            )}
            <button className="secondary" type="button" onClick={switchToSepolia} disabled={!hasMetaMask}>
              Switch Sepolia
            </button>
          </div>
        </div>
      </section>

      {!hasMetaMask && <div className="notice error">MetaMask is required for authentication and bidding.</div>}
      {!contractReady && (
        <div className="notice error">Deploy the contract and set VITE_CONTRACT_ADDRESS in .env.</div>
      )}
      {status && <div className="notice">{status}</div>}

      <section className="dashboard-grid">
        <article className="stat-card">
          <span>Contract</span>
          <strong>{contractReady ? shortAddress(CONTRACT_ADDRESS) : "Not configured"}</strong>
        </article>
        <article className="stat-card">
          <span>Owner</span>
          <strong>{contractOwner ? shortAddress(contractOwner) : "Unknown"}</strong>
        </article>
        <article className="stat-card action-card">
          <span>Refund balance</span>
          <strong>{formatEth(pendingRefund)}</strong>
          <button type="button" onClick={() => withdraw("refund")} disabled={!account || !hasRefund || busyAction === "refund"}>
            Withdraw refund
          </button>
        </article>
        <article className="stat-card action-card">
          <span>Seller proceeds</span>
          <strong>{formatEth(sellerBalance)}</strong>
          <button
            type="button"
            onClick={() => withdraw("proceeds")}
            disabled={!account || !hasProceeds || busyAction === "proceeds"}
          >
            Withdraw proceeds
          </button>
        </article>
      </section>

      {isOwner && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Owner Tools</p>
              <h2>Mint a Training Spot NFT</h2>
            </div>
          </div>

          <form className="mint-form" onSubmit={mintTrainingSpot}>
            <input
              value={spotForm.coachName}
              onChange={(event) => updateSpotForm("coachName", event.target.value)}
              placeholder="Coach name"
            />
            <input
              value={spotForm.trainingDateTime}
              onChange={(event) => updateSpotForm("trainingDateTime", event.target.value)}
              placeholder="Date and time"
            />
            <input
              value={spotForm.location}
              onChange={(event) => updateSpotForm("location", event.target.value)}
              placeholder="Location"
            />
            <input
              value={spotForm.imageURI}
              onChange={(event) => updateSpotForm("imageURI", event.target.value)}
              placeholder="Image URI, optional"
            />
            <input
              value={spotForm.metadataURI}
              onChange={(event) => updateSpotForm("metadataURI", event.target.value)}
              placeholder="Metadata URI, optional"
            />
            <textarea
              value={spotForm.description}
              onChange={(event) => updateSpotForm("description", event.target.value)}
              placeholder="Description"
            />
            <button type="submit" disabled={busyAction === "mint"}>
              {busyAction === "mint" ? "Minting..." : "Mint and list"}
            </button>
          </form>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Live Auctions</p>
            <h2>Auctioned Training Spots</h2>
          </div>
          <button className="secondary" type="button" onClick={() => loadAuctions(account)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {spots.length === 0 ? (
          <div className="empty-state">No training spots have been minted yet.</div>
        ) : (
          <div className="spot-grid">
            {spots.map((item) => {
              const canBid = account && networkOk && !item.sold && !item.ended && !item.expired;
              const canFinalize =
                account &&
                networkOk &&
                item.highestBidder !== ethers.ZeroAddress &&
                !item.sold &&
                !item.ended &&
                (item.expired || isOwner || sameAddress(account, item.seller));
              const imageUrl = ipfsToHttp(item.imageURI);

              return (
                <article className="spot-card" key={item.tokenId}>
                  <div className="spot-image">
                    {imageUrl ? <img src={imageUrl} alt={item.coachName} /> : <span>No image</span>}
                  </div>
                  <div className="spot-body">
                    <div className="spot-title-row">
                      <h3>{item.coachName}</h3>
                      <span className={item.sold || item.ended ? "pill sold" : item.expired ? "pill warning" : "pill success"}>
                        {item.sold || item.ended ? "Sold" : item.expired ? "Expired" : "Open"}
                      </span>
                    </div>
                    <p>{item.description}</p>
                    <dl>
                      <div>
                        <dt>Token</dt>
                        <dd>#{item.tokenId}</dd>
                      </div>
                      <div>
                        <dt>Date/time</dt>
                        <dd>{item.trainingDateTime}</dd>
                      </div>
                      <div>
                        <dt>Location</dt>
                        <dd>{item.location}</dd>
                      </div>
                      <div>
                        <dt>Highest bid</dt>
                        <dd>{item.highestBidder === ethers.ZeroAddress ? "No bids yet" : formatEth(item.highestBid)}</dd>
                      </div>
                      <div>
                        <dt>Highest bidder</dt>
                        <dd>{shortAddress(item.highestBidder)}</dd>
                      </div>
                      <div>
                        <dt>Auction timer</dt>
                        <dd>
                          {item.sold || item.ended
                            ? "Auction finished"
                            : item.expired
                              ? "Can be finalized now"
                              : formatTimeLeft(item.timeLeft)}
                        </dd>
                      </div>
                    </dl>

                    {!item.sold && !item.ended && (
                      <div className="bid-row">
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={bidAmounts[item.tokenId] || ""}
                          onChange={(event) => updateBidAmount(item.tokenId, event.target.value)}
                          placeholder={
                            item.highestBidder === ethers.ZeroAddress
                              ? "Bid in ETH"
                              : `More than ${ethers.formatEther(item.highestBid)} ETH`
                          }
                          disabled={!canBid || busyAction === `bid-${item.tokenId}`}
                        />
                        <button
                          type="button"
                          onClick={() => placeBid(item.tokenId)}
                          disabled={!canBid || busyAction === `bid-${item.tokenId}`}
                        >
                          {busyAction === `bid-${item.tokenId}` ? "Bidding..." : "Place bid"}
                        </button>
                      </div>
                    )}

                    {item.expired && !item.sold && !item.ended && (
                      <p className="hint">No new bid was made within 24 hours. The current highest bidder can win now.</p>
                    )}

                    {canFinalize && (
                      <button
                        className="full-width secondary"
                        type="button"
                        onClick={() => finalizeAuction(item)}
                        disabled={busyAction === `finalize-${item.tokenId}`}
                      >
                        {busyAction === `finalize-${item.tokenId}`
                          ? "Finalizing..."
                          : item.expired
                            ? "Finalize expired auction"
                            : "End auction manually"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
