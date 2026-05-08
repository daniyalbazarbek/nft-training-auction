// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TrainingSpotAuction is ERC721URIStorage, ERC721Holder, Ownable, ReentrancyGuard {
    uint256 public constant BID_TIMEOUT = 24 hours;

    uint256 private _nextTokenId = 1;
    uint256[] private _auctionedTokenIds;

    struct TrainingSpot {
        string coachName;
        string trainingDateTime;
        string description;
        string location;
        string imageURI;
        address seller;
        bool sold;
        bool exists;
    }

    struct Auction {
        uint256 tokenId;
        uint256 highestBid;
        address highestBidder;
        uint256 lastBidAt;
        bool ended;
    }

    mapping(uint256 => TrainingSpot) public spots;
    mapping(uint256 => Auction) public auctions;
    mapping(address => uint256) public pendingReturns;
    mapping(address => uint256) public sellerProceeds;

    event TrainingSpotMinted(uint256 indexed tokenId, address indexed seller);
    event BidPlaced(uint256 indexed tokenId, address indexed bidder, uint256 amount);
    event AuctionEnded(uint256 indexed tokenId, address indexed winner, uint256 amount, bool autoClosed);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC721("Premium Training Spot", "PTS") Ownable(msg.sender) {}

    modifier spotExists(uint256 tokenId) {
        require(spots[tokenId].exists, "Spot does not exist");
        _;
    }

    function mintTrainingSpot(
        string calldata coachName,
        string calldata trainingDateTime,
        string calldata description,
        string calldata location,
        string calldata imageURI,
        string calldata metadataURI
    ) external onlyOwner returns (uint256) {
        require(bytes(coachName).length > 0, "Coach name required");
        require(bytes(trainingDateTime).length > 0, "Training date required");
        require(bytes(description).length > 0, "Description required");
        require(bytes(location).length > 0, "Location required");

        uint256 tokenId = _nextTokenId++;

        _safeMint(address(this), tokenId);
        _setTokenURI(tokenId, metadataURI);

        spots[tokenId] = TrainingSpot({
            coachName: coachName,
            trainingDateTime: trainingDateTime,
            description: description,
            location: location,
            imageURI: imageURI,
            seller: msg.sender,
            sold: false,
            exists: true
        });

        auctions[tokenId] = Auction({
            tokenId: tokenId,
            highestBid: 0,
            highestBidder: address(0),
            lastBidAt: 0,
            ended: false
        });

        _auctionedTokenIds.push(tokenId);

        emit TrainingSpotMinted(tokenId, msg.sender);

        return tokenId;
    }

    function placeBid(uint256 tokenId) external payable nonReentrant spotExists(tokenId) {
        TrainingSpot storage spot = spots[tokenId];
        Auction storage auction = auctions[tokenId];

        require(!spot.sold && !auction.ended, "Auction already finished");
        require(msg.value > auction.highestBid, "Bid must be higher");

        if (auction.highestBidder != address(0)) {
            require(block.timestamp < auction.lastBidAt + BID_TIMEOUT, "Auction expired");
            pendingReturns[auction.highestBidder] += auction.highestBid;
        }

        auction.highestBid = msg.value;
        auction.highestBidder = msg.sender;
        auction.lastBidAt = block.timestamp;

        emit BidPlaced(tokenId, msg.sender, msg.value);
    }

    function endAuction(uint256 tokenId) external nonReentrant spotExists(tokenId) {
        TrainingSpot storage spot = spots[tokenId];
        require(msg.sender == owner() || msg.sender == spot.seller, "Only seller or owner");

        _finalizeAuction(tokenId, false);
    }

    function finalizeExpiredAuction(uint256 tokenId) external nonReentrant spotExists(tokenId) {
        Auction storage auction = auctions[tokenId];

        require(auction.highestBidder != address(0), "No bids placed");
        require(block.timestamp >= auction.lastBidAt + BID_TIMEOUT, "Auction still active");

        _finalizeAuction(tokenId, true);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        pendingReturns[msg.sender] = 0;

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit Withdrawal(msg.sender, amount);
    }

    function withdrawSellerProceeds() external nonReentrant {
        uint256 amount = sellerProceeds[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        sellerProceeds[msg.sender] = 0;

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit Withdrawal(msg.sender, amount);
    }

    function getAuctionedTokenIds() external view returns (uint256[] memory) {
        return _auctionedTokenIds;
    }

    function getTokenCount() external view returns (uint256) {
        return _auctionedTokenIds.length;
    }

    function isAuctionExpired(uint256 tokenId) external view spotExists(tokenId) returns (bool) {
        Auction storage auction = auctions[tokenId];

        return !auction.ended && auction.highestBidder != address(0) && block.timestamp >= auction.lastBidAt + BID_TIMEOUT;
    }

    function timeLeft(uint256 tokenId) external view spotExists(tokenId) returns (uint256) {
        Auction storage auction = auctions[tokenId];

        if (auction.ended || auction.highestBidder == address(0)) {
            return 0;
        }

        uint256 deadline = auction.lastBidAt + BID_TIMEOUT;

        if (block.timestamp >= deadline) {
            return 0;
        }

        return deadline - block.timestamp;
    }

    function _finalizeAuction(uint256 tokenId, bool autoClosed) private {
        TrainingSpot storage spot = spots[tokenId];
        Auction storage auction = auctions[tokenId];

        require(!spot.sold && !auction.ended, "Auction already finished");
        require(auction.highestBidder != address(0), "No bids placed");

        address winner = auction.highestBidder;
        address seller = spot.seller;
        uint256 amount = auction.highestBid;

        auction.ended = true;
        spot.sold = true;
        sellerProceeds[seller] += amount;

        _safeTransfer(address(this), winner, tokenId, "");

        emit AuctionEnded(tokenId, winner, amount, autoClosed);
    }
}
