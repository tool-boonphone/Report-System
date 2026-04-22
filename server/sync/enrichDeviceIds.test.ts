/**
 * Regression coverage for the IMEI / Serial enrichment path.
 *
 * The contract list endpoint does not expose device identifiers; those live in
 * `contract?action=detail` under `contract.product`. `mapContractDetailOverrides`
 * is the function that pulls them into the row we pass to the upsert. This
 * test pins that mapping so a future refactor cannot silently drop either
 * column again (we previously shipped a runner that never called it).
 */
import { describe, it, expect } from "vitest";
import { mapContractDetailOverrides } from "../api/mappers";

describe("mapContractDetailOverrides — imei/serial", () => {
  it("maps product.imei and product.serial_no into the contract row", () => {
    const payload = {
      contract: {
        id: 1234,
        code: "CT-TEST-0001",
        product: {
          imei: "356938035643809",
          serial_no: "F2LKQ8XJHJ7M",
        },
      },
    };
    const row = mapContractDetailOverrides("Boonphone", payload);
    expect(row.imei).toBe("356938035643809");
    expect(row.serialNo).toBe("F2LKQ8XJHJ7M");
    expect(row.externalId).toBe("1234");
  });

  it("returns null imei for Wi-Fi-only devices that omit the field", () => {
    // Real-world shape for an iPad Wi-Fi order returned by the partner API:
    // serial is present but imei is absent because the hardware has no GSM
    // modem. We want the mapper to surface `null` (not "undefined" or throw),
    // which is what lets `enrichContractsWithDeviceIds` skip the pointless
    // UPDATE and keep the serial_no column populated.
    const payload = {
      contract: {
        id: 1000,
        code: "CT0226-UTT002-0941-01",
        product: {
          serial_no: "MR7L4GL2LG",
          // imei intentionally missing
        },
      },
    };
    const row = mapContractDetailOverrides("Boonphone", payload);
    expect(row.imei).toBeNull();
    expect(row.serialNo).toBe("MR7L4GL2LG");
  });

  it("is defensive against missing product / detail objects", () => {
    expect(() =>
      mapContractDetailOverrides("Boonphone", { contract: {} }),
    ).not.toThrow();
    const row = mapContractDetailOverrides("Boonphone", { contract: {} });
    expect(row.imei).toBeNull();
    expect(row.serialNo).toBeNull();
  });
});
