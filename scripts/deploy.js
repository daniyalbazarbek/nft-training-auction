const hre = require("hardhat");

async function main() {
  const TrainingSpotAuction = await hre.ethers.getContractFactory("TrainingSpotAuction");
  const auction = await TrainingSpotAuction.deploy();

  await auction.waitForDeployment();

  const address = await auction.getAddress();
  console.log(`TrainingSpotAuction deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
