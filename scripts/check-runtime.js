const expectedNode = 'v24.21.0';
const expectedNpm = '10.9.4';
const npmVersion = process.env.npm_config_user_agent?.match(/npm\/(\d+\.\d+\.\d+)/)?.[1];

if (process.version !== expectedNode) {
  console.error(`Use Node.js ${expectedNode}; detected ${process.version}.`);
  process.exit(1);
}
if (npmVersion && npmVersion !== expectedNpm) {
  console.error(`Use npm ${expectedNpm}; detected ${npmVersion}.`);
  process.exit(1);
}
