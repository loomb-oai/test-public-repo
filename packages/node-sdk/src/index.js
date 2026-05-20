const SDK_VERSION = "0.1.0";

export function node_gday(name = "release-action") {
  return `g'day ${name} from the demo Node SDK`;
}

export function node_goodbye(name = "release-action") {
  return `hooroo ${name} from the demo Node SDK`;
}

export function get_sdk_version() {
  return SDK_VERSION;
}
