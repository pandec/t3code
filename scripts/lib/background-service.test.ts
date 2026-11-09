// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { serviceOwnsHome } from "./background-service.ts";

it("matches the service's T3 home, treating an unset home as the default", () => {
  const service = { name: "t3code.service", restartCommand: "" };
  const defaultHome = NodePath.join(NodeOS.homedir(), ".t3");
  assert.isTrue(serviceOwnsHome({ ...service, home: undefined }, defaultHome));
  assert.isFalse(serviceOwnsHome({ ...service, home: undefined }, "/srv/t3"));
  assert.isTrue(serviceOwnsHome({ ...service, home: "/srv/t3" }, "/srv/t3"));
  assert.isFalse(serviceOwnsHome({ ...service, home: "/srv/t3" }, defaultHome));
});
