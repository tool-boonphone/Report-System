import { describe, expect, it } from "vitest";
import { mapContactAddressFields } from "../api/addressFields";
import { formatNoticeMailingAddress } from "./addressFormat";

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
});
