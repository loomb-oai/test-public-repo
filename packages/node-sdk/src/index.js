const SDK_VERSION = "0.1.0";

export function helloFromNode(name = "release-action") {
  return `hello ${name} from the demo Node SDK`;
}

export function get_sdk_version() {
  return SDK_VERSION;
}
