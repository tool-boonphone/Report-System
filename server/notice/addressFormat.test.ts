import { describe, expect, it } from "vitest";
import { isLikelyAddressLine, mapContactAddressFields, parseThaiAddressLine } from "../api/addressFields";
import { mapContractDetailOverrides } from "../api/mappers";
import { formatNoticeMailingAddress, resolveNoticeMailingAddress } from "./addressFormat";

describe("formatNoticeMailingAddress", () => {
  it("formats full Thai postal address", () => {
    const s = formatNoticeMailingAddress({
      addrHouseNo: "34/46",
      addrStreet: "คลองถนน",
      addrSubdistrict: "บางแม่นาง",
      addrDistrict: "บางใหญ่",
      addrProvince: "นนทบุรี",
    });
    expect(s).toBe("34/46 ถ.คลองถนน ต.บางแม่นาง อ.บางใหญ่ จ.นนทบุรี");
  });

  it("includes optional moo and village", () => {
    const s = formatNoticeMailingAddress({
      addrHouseNo: "12",
      addrMoo: "2",
      addrVillage: "หมู่บ้านสุขใจ",
      addrSoi: "5",
      addrSubdistrict: "ลำโพ",
      addrDistrict: "บางบัวทอง",
      addrProvince: "นนทบุรี",
    });
    expect(s).toContain("หมู่ 2");
    expect(s).toContain("หมู่บ้านสุขใจ");
    expect(s).toContain("ซ.5");
  });

  it("falls back to district+province when detail fields missing", () => {
    const s = formatNoticeMailingAddress({
      addrDistrict: "บางใหญ่",
      addrProvince: "นนทบุรี",
    });
    expect(s).toBe("อ.บางใหญ่ จ.นนทบุรี");
  });
});

describe("parseThaiAddressLine", () => {
  it("parses full address line from customer workplace", () => {
    const f = parseThaiAddressLine(
      "บ้านเลขที่ 5/3 หมู่ 3 ตำบลเสม็ดใต้ อำเภอบางคล้า จังหวัดฉะเชิงเทรา 24110",
    );
    expect(f.addrHouseNo).toBe("5/3");
    expect(f.addrMoo).toBe("3");
    expect(f.addrSubdistrict).toBe("เสม็ดใต้");
    expect(f.addrDistrict).toBe("บางคล้า");
    expect(f.addrProvince).toBe("ฉะเชิงเทรา");
    expect(f.addrPostalCode).toBe("24110");
  });

  it("rejects placeholder occupation text", () => {
    expect(isLikelyAddressLine("ที่อยู่ปัจจุบัน")).toBe(false);
  });
});

describe("resolveNoticeMailingAddress", () => {
  it("uses workplace when structured addr fields are empty", () => {
    const s = resolveNoticeMailingAddress({
      addrDistrict: "บางคล้า",
      addrProvince: "ฉะเชิงเทรา",
      workplace: "บ้านเลขที่ 5/3 หมู่ 3 ตำบลเสม็ดใต้ อำเภอบางคล้า จังหวัดฉะเชิงเทรา 24110",
    });
    expect(s).toContain("5/3");
    expect(s).toContain("หมู่ 3");
    expect(s).toContain("ต.เสม็ดใต้");
  });

  it("fills missing subdistrict from workplace when DB has only district/province", () => {
    const s = resolveNoticeMailingAddress({
      addrDistrict: "บางคล้า",
      addrProvince: "ฉะเชิงเทรา",
      workplace: "บ้านเลขที่ 5/3 หมู่ 3 ตำบลเสม็ดใต้ อำเภอบางคล้า จังหวัดฉะเชิงเทรา 24110",
    });
    expect(s).toContain("ต.เสม็ดใต้");
    expect(s).toContain("อ.บางคล้า");
  });

  it("CT0126-SRI001-22191-01: FF365 เก็บตำบลใน district field", () => {
    const s = resolveNoticeMailingAddress({
      workplace: "บริษัทไทยซิง",
      addrDistrict: "ระโสม",
      addrProvince: "พระนครศรีอยุธยา",
    });
    expect(s).toContain("ต.ระโสม");
    expect(s).toContain("อ.ภาชี");
    expect(s).toContain("จ.พระนครศรีอยุธยา");
    expect(s).not.toMatch(/อ\.ระโสม/);
  });

  it("keeps amphoe names as อ. prefix (บางบัวทอง)", () => {
    const s = resolveNoticeMailingAddress({
      addrDistrict: "บางบัวทอง",
      addrProvince: "นนทบุรี",
    });
    expect(s).toBe("อ.บางบัวทอง จ.นนทบุรี");
  });
});

describe("mapContactAddressFields", () => {
  it("maps partner contact_address keys", () => {
    const f = mapContactAddressFields({
      house_no: "34/46",
      road: "คลองถนน",
      tambon: "บางแม่นาง",
      amphure: "บางใหญ่",
      province: "นนทบุรี",
      zipcode: "11140",
    });
    expect(f.addrHouseNo).toBe("34/46");
    expect(f.addrStreet).toBe("คลองถนน");
    expect(f.addrSubdistrict).toBe("บางแม่นาง");
    expect(f.addrDistrict).toBe("บางใหญ่");
    expect(f.addrProvince).toBe("นนทบุรี");
    expect(f.addrPostalCode).toBe("11140");
  });

  it("parses full address string field when structured keys missing", () => {
    const f = mapContactAddressFields({
      address: "บ้านเลขที่ 136/9 ม.10",
      amphure: "บางบัวทอง",
      province: "นนทบุรี",
    });
    expect(f.addrHouseNo).toBe("136/9");
    expect(f.addrMoo).toBe("10");
  });

  it("parses tambon from address line even when house_no is already set", () => {
    const f = mapContactAddressFields({
      house_no: "136/9",
      moo: "10",
      amphure: "บางบัวทอง",
      province: "นนทบุรี",
      address: "บ้านเลขที่ 136/9 หมู่ 10 ตำบลบางบัวทอง อำเภอบางบัวทอง จังหวัดนนทบุรี 11110",
    });
    expect(f.addrHouseNo).toBe("136/9");
    expect(f.addrMoo).toBe("10");
    expect(f.addrSubdistrict).toBe("บางบัวทอง");
    expect(f.addrPostalCode).toBe("11110");
  });
});

describe("mapContractDetailOverrides — mailing address", () => {
  it("fills subdistrict from contact_address.address when tambon key is missing", () => {
    const row = mapContractDetailOverrides("Fastfone365", {
      contract: {
        id: 99,
        code: "CT-TEST",
        contact_address: {
          house_no: "12/3",
          amphure: "บางใหญ่",
          province: "นนทบุรี",
          address: "บ้านเลขที่ 12/3 หมู่ 5 ตำบลบางแม่นาง อำเภอบางใหญ่ จังหวัดนนทบุรี 11140",
        },
      },
    });
    expect(row.addrSubdistrict).toBe("บางแม่นาง");
    expect(row.addrPostalCode).toBe("11140");
  });

  it("fills subdistrict from card_address when contact_address lacks tambon", () => {
    const row = mapContractDetailOverrides("Fastfone365", {
      contract: {
        id: 100,
        code: "CT-TEST-2",
        contact_address: {
          house_no: "7",
          amphure: "บางคล้า",
          province: "ฉะเชิงเทรา",
        },
        card_address: {
          tambon: "เสม็ดใต้",
          amphure: "บางคล้า",
          province: "ฉะเชิงเทรา",
        },
      },
    });
    expect(row.addrSubdistrict).toBe("เสม็ดใต้");
  });
});
