export function assertPort(port, name, methods) {
  if (!port || typeof port !== "object") {
    throw new TypeError(`${name} port must be an object.`);
  }
  for (const method of methods) {
    if (typeof port[method] !== "function") {
      throw new TypeError(`${name} port must implement ${method}().`);
    }
  }
  return port;
}

export function assertRuntimeConfig(config, component) {
  if (!config || config.component !== component) {
    throw new TypeError(`Expected parsed ${component} configuration.`);
  }
  return config;
}
