import BaseData from "./base";
import { EStubType, Stub } from "./stub";

export interface DeploymentData extends BaseData {
  name: string;
  version: number;
  active: boolean;
  stubType: EStubType;
  stub: Stub;
}
