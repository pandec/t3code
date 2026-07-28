import * as Schema from "effect/Schema";

const AppleTeamId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/));
const IosBundleIdentifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
);
const AppVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));
const IosBuildNumber = Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+){0,2}$/));
const AppStoreConnectKeyId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/));
const AppStoreConnectIssuerId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);

export const isAppleTeamId = Schema.is(AppleTeamId);
export const isIosBundleIdentifier = Schema.is(IosBundleIdentifier);
export const isAppVersion = Schema.is(AppVersion);
export const isIosBuildNumber = Schema.is(IosBuildNumber);
export const isAppStoreConnectKeyId = Schema.is(AppStoreConnectKeyId);
export const isAppStoreConnectIssuerId = Schema.is(AppStoreConnectIssuerId);
