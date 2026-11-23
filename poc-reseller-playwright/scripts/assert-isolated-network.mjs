import { networkInterfaces } from 'node:os';

const externalAddresses = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => !address.internal && address.address);

if (process.env.POC_DOCKER_RUNTIME !== '1' || externalAddresses.length > 0) {
  console.error(
    JSON.stringify({
      status: 'network_not_isolated',
      externalInterfaceCount: externalAddresses.length,
    }),
  );
  process.exit(1);
}

console.log(JSON.stringify({ status: 'network_isolated' }));
