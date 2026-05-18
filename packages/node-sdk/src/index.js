const SDK_VERSION = "0.1.0";

export function node_hello_world(name = "release-action") {
  return `hello ${name} from the demo Node SDK`;
}

export function get_sdk_version() {
  return SDK_VERSION;
}
