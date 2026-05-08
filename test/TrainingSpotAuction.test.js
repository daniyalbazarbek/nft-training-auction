const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TrainingSpotAuction", function () {
  const oneEth = ethers.parseEther("1");
  const twoEth = ethers.parseEther("2");
  const bidTimeout = 24 * 60 * 60;

  let auction;
  let owner;
  let bidder1;
  let bidder2;

  async function mintSpot() {
    await auction.mintTrainingSpot(
      "Lionel Messi",
      "2026-06-10 10:00 UTC",
      "Private elite conditioning session",
      "Astana Premium Gym",
      "ipfs://training-image",
      "ipfs://training-metadata"
    );

    return 1n;
  }

  beforeEach(async function () {
    [owner, bidder1, bidder2] = await ethers.getSigners();

    const TrainingSpotAuction = await ethers.getContractFactory("TrainingSpotAuction");
    auction = await TrainingSpotAuction.deploy();
    await auction.waitForDeployment();
  });

  it("mints and lists a training spot NFT for auction", async function () {
    const tokenId = await mintSpot();
    const contractAddress = await auction.getAddress();

    expect(await auction.ownerOf(tokenId)).to.equal(contractAddress);

    const ids = await auction.getAuctionedTokenIds();
    expect(ids).to.deep.equal([tokenId]);

    const spot = await auction.spots(tokenId);
    expect(spot.coachName).to.equal("Lionel Messi");
    expect(spot.trainingDateTime).to.equal("2026-06-10 10:00 UTC");
    expect(spot.location).to.equal("Astana Premium Gym");
    expect(spot.seller).to.equal(owner.address);
    expect(spot.sold).to.equal(false);
  });

  it("allows only bids higher than the current highest bid", async function () {
    const tokenId = await mintSpot();

    await expect(auction.connect(bidder1).placeBid(tokenId, { value: oneEth }))
      .to.emit(auction, "BidPlaced")
      .withArgs(tokenId, bidder1.address, oneEth);

    await expect(auction.connect(bidder2).placeBid(tokenId, { value: oneEth })).to.be.revertedWith(
      "Bid must be higher"
    );

    const currentAuction = await auction.auctions(tokenId);
    expect(currentAuction.highestBid).to.equal(oneEth);
    expect(currentAuction.highestBidder).to.equal(bidder1.address);
  });

  it("stores the previous highest bid for withdrawal", async function () {
    const tokenId = await mintSpot();

    await auction.connect(bidder1).placeBid(tokenId, { value: oneEth });
    await auction.connect(bidder2).placeBid(tokenId, { value: twoEth });

    expect(await auction.pendingReturns(bidder1.address)).to.equal(oneEth);

    await expect(auction.connect(bidder1).withdraw()).to.changeEtherBalance(bidder1, oneEth);
    expect(await auction.pendingReturns(bidder1.address)).to.equal(0n);
  });

  it("lets the owner manually end the auction and transfer the NFT to the winner", async function () {
    const tokenId = await mintSpot();

    await auction.connect(bidder1).placeBid(tokenId, { value: oneEth });

    await expect(auction.endAuction(tokenId))
      .to.emit(auction, "AuctionEnded")
      .withArgs(tokenId, bidder1.address, oneEth, false);

    expect(await auction.ownerOf(tokenId)).to.equal(bidder1.address);
    expect(await auction.sellerProceeds(owner.address)).to.equal(oneEth);

    const spot = await auction.spots(tokenId);
    expect(spot.sold).to.equal(true);
  });

  it("automatically finalizes after 24 hours without a new bid", async function () {
    const tokenId = await mintSpot();

    await auction.connect(bidder1).placeBid(tokenId, { value: oneEth });
    await time.increase(bidTimeout + 1);

    await expect(auction.connect(bidder2).finalizeExpiredAuction(tokenId))
      .to.emit(auction, "AuctionEnded")
      .withArgs(tokenId, bidder1.address, oneEth, true);

    expect(await auction.ownerOf(tokenId)).to.equal(bidder1.address);
  });

  it("does not finalize automatically before 24 hours", async function () {
    const tokenId = await mintSpot();

    await auction.connect(bidder1).placeBid(tokenId, { value: oneEth });
    await time.increase(bidTimeout - 60);

    await expect(auction.finalizeExpiredAuction(tokenId)).to.be.revertedWith("Auction still active");
  });

  it("prevents bidding or duplicate sale after the NFT is sold", async function () {
    const tokenId = await mintSpot();

    await auction.connect(bidder1).placeBid(tokenId, { value: oneEth });
    await auction.endAuction(tokenId);

    await expect(auction.connect(bidder2).placeBid(tokenId, { value: twoEth })).to.be.revertedWith(
      "Auction already finished"
    );

    await expect(auction.endAuction(tokenId)).to.be.revertedWith("Auction already finished");
  });

  it("allows only the contract owner to mint training spots", async function () {
    await expect(
      auction
        .connect(bidder1)
        .mintTrainingSpot("Coach", "2026-06-10", "Session", "Gym", "", "")
    )
      .to.be.revertedWithCustomError(auction, "OwnableUnauthorizedAccount")
      .withArgs(bidder1.address);
  });
});
