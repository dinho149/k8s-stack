import type { DeepPartial } from "../../lib/merge";
import type { Platform, StackConfigInput } from "../schema";
import { aksDefaults } from "./aks";
import { eksDefaults } from "./eks";
import { genericDefaults } from "./generic";
import { gkeDefaults } from "./gke";
import { kindDefaults } from "./kind";

export const platformDefaults: Record<Platform, DeepPartial<StackConfigInput>> = {
  kind: kindDefaults,
  eks: eksDefaults,
  gke: gkeDefaults,
  aks: aksDefaults,
  generic: genericDefaults,
};
