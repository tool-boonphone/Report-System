# รายงานสรุปข้อมูล MDM API (mdm-th.com)

เอกสารฉบับนี้สรุปข้อมูล API ทั้งหมดของระบบ MDM (Mobile Device Management) ที่ให้บริการผ่าน `mdm-th.com` โดยครอบคลุม 40 Endpoints ใน 9 หมวดหมู่

## 1. ข้อมูลพื้นฐาน (Base Information)

- **Base URL:** `https://mdm-th.com`
- **Authentication:** ใช้ Header `X-API-Key: <YOUR_API_KEY>` สำหรับทุก Request
- **Content-Type:** `application/json` สำหรับ POST requests

## 2. หมวดหมู่และ Endpoints

### Authentication

#### Get Authorization
- **Method:** `POST`
- **Path:** `/api/mdm/get-authorization`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | The authorization token |
| `code` | integer | Status code (200) |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "eyJhbGciOiJIUzUxMiJ9.eyJsb2dpbl91c2VyX2tleSI6IjczYWI0M2MyLWQ2YmItNDg5OC1iOTYxLWVjYWVmOWM5MjFlNSJ9.-pqXknBgGHl094omGA2hS-95x50FJzsCYetq0nMWiL1Q4yaPG8VvstoZyUowZ7SVxAKMDB0fsPIlWdTUzaDQQA",
  "code": 200
}
```

---

### Account

#### Add Sub Account
- **Method:** `POST`
- **Path:** `/api/mdm/account/add`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `account` | string | Account name, must be unique |
| `companyName` | string | Company name |
| `ip` | string | IP address |
| `name` | string | Platform username |
| `password` | string | Account password |
| `phone` | string | Phone number |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Return message |
| `code` | integer | Status code |
| `data` | object | Account data |
| `success` | boolean | Operation success status |
| `01HDJ89PA4E2WSFD2Z5ZG2ADVB` | string | Response identifier |
| `Name` | Type | Description |
| `msg` | string | Return message |
| `code` | integer | Status code |
| `sign` | string | Account secret key, must be saved |
| `userId` | integer | Account ID, must be saved |
| `account` | string | Account name, must be saved |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "account": "example@mdm.com",
  "companyName": "Example Company",
  "ip": "192.168.1.100",
  "name": "John Doe",
  "password": "securePassword123",
  "phone": "+1234567890"
}
```

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": {
    "msg": "Operation successful",
    "code": 200,
    "sign": "nQTapKCNlyb4GJxj",
    "userId": 1663,
    "account": "ChVMifEXqTceshi@mdm.com"
  },
  "success": true,
  "01HDJ89PA4E2WSFD2Z5ZG2ADVB": "response_identifier"
}
```

---

### Devices

#### Device List
- **Method:** `GET`
- **Path:** `/api/mdm/devices`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `createTimeEnd` | string | End time for device creation filter |
| `createTimeStart` | string | Start time for device creation filter |
| `deviceId` | string | Device serial number |
| `isDel` | integer | Deletion status. Default: empty. Values: 0-Not deleted/managed, 1-Retired, 2-Deleted/managed |
| `lastTimeEnd` | string | End time for last communication filter |
| `lastTimeStart` | string | Start time for last communication filter |
| `lossStatus` | integer | Loss status. Values: 0-Not lost, 1-Lost |
| `modelType` | integer | Device type. Values: 0-iPhone, 1-iPad, 2-Mac |
| `name` | string | Username |
| `pageNum` | integer | Page number (for pagination) |
| `pageSize` | integer | Page size (for pagination) |
| `phone` | string | Phone number |
| `status` | integer | Management status. Values: 0-Not managed, 1-Managed, 2-Unmanaged |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `total` | integer | Total number of devices |
| `rows` | array | Array of device objects |
| `code` | integer | Status code |
| `Name` | Type | Description |
| `id` | integer | Device ID |
| `deviceId` | string | Device serial number |
| `userId` | integer | User ID |
| `deviceName` | string | Device model |
| `account` | null | Associated account |
| `companyName` | null | Company name |
| `userName` | null | Associated account name |
| `name` | string | Name |
| `phone` | string | Phone number |
| `deviceLock` | integer | Activation lock status. Values: 0-Locked, 1-Unlocked |
| `status` | integer | Server status. Values: 0-Not managed, 1-Managed, 2-Unmanaged |
| `imageId` | integer | Wallpaper ID |
| `modelType` | integer | Device type. Values: 0-Phone, 1-Tablet, 2-Computer |
| `udid` | string | Device UDID |
| `imei` | string | IMEI |
| `meid` | string | MEID |
| `phoneNumber` | null | SIM 1 phone number |
| `currentCarrierNetwork` | null | SIM 1 carrier |
| `imei2` | null | IMEI 2 |
| `phoneNumber2` | null | SIM 2 phone number |
| `currentCarrierNetwork2` | null | SIM 2 carrier |
| `allowType` | string | Permission settings JSON string containing: allowAppTrust, allowProfileInstall, allowEraseContent, allowUsb, forceAutomaticDateAndTime, allowVPNCreation |
| `productName` | string | Device model identifier |
| `lossStatus` | integer | Loss status. Values: 0-Not locked, 1-Lost mode set |
| `usbType` | integer | USB restriction. Values: 0-No, 1-Yes |
| `allowImage` | integer | Wallpaper modification permission. Values: 0-Allowed, 1-Not allowed |
| `allowAppType` | integer | App restriction removal. Values: 0-Allow only, 1-Remove all restrictions |
| `apps` | string | Apps JSON string |
| `lockEndTime` | string | Computer lock end time |
| `isDel` | integer | Deletion status. Values: 0-Normal, 1-Retired, 2-Deleted/managed |
| `createdAt` | string | Creation time |
| `lastTime` | string | Last communication time |
| `updatedAt` | null | Update time |
| `times` | string | Last communication duration |
| `osVersion` | string | System version |
| `lastIp` | null | Last IP address |
| `createBy` | integer | Creator ID |
| `createByName` | string | Creator name |

**Response Example:**
```json
{
  "total": 22,
  "rows": [
    {
      "id": 107018,
      "deviceId": "H6Q7JDQ9WQ",
      "userId": 531,
      "deviceName": "iPhone 13",
      "account": null,
      "companyName": null,
      "userName": null,
      "name": "",
      "phone": "",
      "deviceLock": 0,
      "status": 2,
      "imageId": 101,
      "modelType": 0,
      "udid": "00008110-0012755A3CE1801E",
      "imei": "35 305718 422724 0",
      "meid": "35305718422724",
      "phoneNumber": null,
      "currentCarrierNetwork": null,
      "imei2": null,
      "phoneNumber2": null,
      "currentCarrierNetwork2": null,
      "allowType": "{\"allowAppTrust\":1,\"allowProfileInstall\":1,\"allowEraseContent\":1,\"allowUsb\":1,\"forceAutomaticDateAndTime\":1,\"allowVPNCreation\":1}",
      "productName": "iPhone14,5",
      "lossStatus": 0,
      "usbType": 1,
      "allowImage": 0,
      "allowAppType": 1,
      "apps": "",
      "lockEndTime": "",
      "isDel": 2,
      "createdAt": "2024-02-05 11:13:45",
      "lastTime": "2024-01-10 11:28:45",
      "updatedAt": null,
      "times": "44天3小时32分钟",
      "osVersion": "17.3",
      "lastIp": null,
      "createBy": 531,
      "createByName": "xing@mdm.com"
    }
  ],
  "code": 200
}
```

---

#### Get Device Types
- **Method:** `GET`
- **Path:** `/api/mdm/devices/types`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `data` | array | Array of device type objects |
| `Name` | Type | Description |
| `id` | integer | Device type ID |
| `type` | integer | Device type. Values: 0-iPhone, 1-iPad, 2-Mac |
| `model` | string | Device model name |
| `sort` | integer | Sort order |
| `status` | integer | Status |
| `productName` | string | Product identifier |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": [
    {
      "id": 8,
      "type": 0,
      "model": "iPhone 15",
      "sort": 1,
      "status": 0,
      "productName": "iPhone15,4"
    },
    {
      "id": 9,
      "type": 0,
      "model": "iPhone 15 Pro",
      "sort": 2,
      "status": 0,
      "productName": "iPhone16,1"
    },
    {
      "id": 10,
      "type": 0,
      "model": "iPhone 15 plus",
      "sort": 3,
      "status": 0,
      "productName": "iPhone15,5"
    },
    {
      "id": 11,
      "type": 0,
      "model": "iPhone 15 Pro Max",
      "sort": 4,
      "status": 0,
      "productName": "iPhone16,2"
    },
    {
      "id": 29,
      "type": 1,
      "model": "iPad mini6 WiFi版",
      "sort": 29,
      "status": 0,
      "productName": ""
    },
    {
      "id": 39,
      "type": 2,
      "model": "Mac",
      "sort": 39,
      "status": 0,
      "productName": ""
    }
  ]
}
```

---

#### Add Device
- **Method:** `POST`
- **Path:** `/api/mdm/devices`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `deviceId` | string | Device serial number |
| `name` | string | User name |
| `phone` | string | Phone number |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | boolean | Operation success status |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "deviceId": "123131334",
  "phone": "18118657417",
  "name": "John Doe"
}
```

**Response Example:**
```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": true
}
```

---

#### Edit Device
- **Method:** `POST`
- **Path:** `/api/mdm/devices/edit`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `name` | string | User name |
| `phone` | string | Phone number |
| `deviceName` | string | Device name |
| `isDel` | integer | Retirement status. Values: 0-No, 1-Yes |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | boolean | Operation success status |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "name": "John Doe",
  "phone": "+1234567890",
  "deviceName": "iPhone 13 Pro",
  "isDel": 0
}
```

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": true
}
```

---

#### Get Device Details by ID
- **Method:** `GET`
- **Path:** `/api/mdm/devices/{id}`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `success` | boolean | Operation success status |
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | object | Device details object |
| `Name` | Type | Description |
| `id` | integer | Device ID |
| `deviceId` | string | Device serial number |
| `userId` | integer | User ID |
| `deviceName` | string | Device model |
| `name` | string | User name |
| `phone` | string | Phone number |
| `deviceLock` | integer | Activation lock status. Values: 0-Locked, 1-Unlocked |
| `status` | integer | Management status. Values: 0-Not managed, 1-Managed, 2-Unmanaged |
| `imageId` | integer | Wallpaper ID |
| `modelType` | integer | Device type. Values: 0-iPhone, 1-iPad, 2-Mac |
| `allowAppType` | integer | App trust restriction |
| `udid` | string | Device UDID |
| `imei` | string | IMEI |
| `meid` | string | MEID |
| `allowType` | string | Permission settings JSON string |
| `productName` | string | Product identifier |
| `lossStatus` | integer | Loss status. Values: 0-Not locked, 1-Lost mode set |
| `usbType` | integer | USB restriction |
| `allowImage` | integer | Wallpaper modification permission |
| `apps` | string | Apps JSON string |
| `lockEndTime` | string | Lock end time |
| `isDel` | integer | Deletion status. Values: 0-Normal, 1-Retired, 2-Deleted/managed |
| `createdAt` | string | Creation time |
| `lastTime` | string | Last communication time |
| `updatedAt` | string | Update time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "success": true,
  "code": 1,
  "msg": "Operation successful",
  "data": {
    "id": 48802,
    "deviceId": "FFNGJSWXHFXP",
    "userId": 129,
    "deviceName": "iPhone 14 Pro",
    "name": "11",
    "phone": "11",
    "deviceLock": 1,
    "status": 2,
    "imageId": 1391,
    "modelType": 0,
    "allowAppType": 1,
    "udid": "00008101-0AS3DF23GG234CF1003A",
    "imei": "35 687621 025447 3",
    "meid": "35687621025447",
    "allowType": "{\"allowAppTrust\":0,\"allowProfileInstall\":1,\"allowEraseContent\":1,\"allowUsb\":1,\"forceAutomaticDateAndTime\":1,\"allowVPNCreation\":0}",
    "productName": "iPhone13,2",
    "lossStatus": 0,
    "usbType": 1,
    "allowImage": 0,
    "apps": "",
    "lockEndTime": "",
    "isDel": 0,
    "createdAt": "2023-07-19 15:32:01",
    "lastTime": "2023-12-06 19:03:43",
    "updatedAt": "2023-10-23 18:13:14"
  }
}
```

---

#### Get Device Details by IMEI
- **Method:** `GET`
- **Path:** `/api/mdm/devices/imei/{imei}`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `success` | boolean | Operation success status |
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | object | Device details object |
| `Name` | Type | Description |
| `id` | integer | Device ID |
| `deviceId` | string | Device serial number |
| `userId` | integer | User ID |
| `deviceName` | string | Device model |
| `name` | string | User name |
| `phone` | string | Phone number |
| `deviceLock` | integer | Activation lock status. Values: 0-Locked, 1-Unlocked |
| `status` | integer | Management status. Values: 0-Not managed, 1-Managed, 2-Unmanaged |
| `imageId` | integer | Wallpaper ID |
| `modelType` | integer | Device type. Values: 0-iPhone, 1-iPad, 2-Mac |
| `allowAppType` | integer | App trust restriction |
| `udid` | string | Device UDID |
| `imei` | string | IMEI |
| `meid` | string | MEID |
| `allowType` | string | Permission settings JSON string |
| `productName` | string | Product identifier |
| `lossStatus` | integer | Loss status. Values: 0-Not locked, 1-Lost mode set |
| `usbType` | integer | USB restriction |
| `allowImage` | integer | Wallpaper modification permission |
| `apps` | string | Apps JSON string |
| `lockEndTime` | string | Lock end time |
| `isDel` | integer | Deletion status. Values: 0-Normal, 1-Retired, 2-Deleted/managed |
| `createdAt` | string | Creation time |
| `lastTime` | string | Last communication time |
| `updatedAt` | string | Update time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "success": true,
  "code": 1,
  "msg": "Operation successful",
  "data": {
    "id": 48802,
    "deviceId": "FFNGJSWXHFXP",
    "userId": 129,
    "deviceName": "iPhone 14 Pro",
    "name": "11",
    "phone": "11",
    "deviceLock": 1,
    "status": 2,
    "imageId": 1391,
    "modelType": 0,
    "allowAppType": 1,
    "udid": "00008101-0AS3DF23GG234CF1003A",
    "imei": "35 687621 025447 3",
    "meid": "35687621025447",
    "allowType": "{\"allowAppTrust\":0,\"allowProfileInstall\":1,\"allowEraseContent\":1,\"allowUsb\":1,\"forceAutomaticDateAndTime\":1,\"allowVPNCreation\":0}",
    "productName": "iPhone13,2",
    "lossStatus": 0,
    "usbType": 1,
    "allowImage": 0,
    "apps": "",
    "lockEndTime": "",
    "isDel": 0,
    "createdAt": "2023-07-19 15:32:01",
    "lastTime": "2023-12-06 19:03:43",
    "updatedAt": "2023-10-23 18:13:14"
  }
}
```

---

#### Get Device Details by Serial Number
- **Method:** `GET`
- **Path:** `/api/mdm/devices/by-serial`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `deviceId` | string | Device serial number |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `data` | object | Device details object |
| `Name` | Type | Description |
| `id` | integer | Device ID |
| `deviceId` | string | Device serial number |
| `userId` | integer | User ID |
| `deviceName` | string | Device model |
| `account` | null | Associated account |
| `companyName` | null | Company name |
| `userName` | null | Associated account name |
| `name` | string | Name |
| `phone` | string | Phone number |
| `deviceLock` | integer | Activation lock status. Values: 0-Locked, 1-Unlocked |
| `status` | integer | Server status. Values: 0-Not managed, 1-Managed, 2-Unmanaged |
| `imageId` | integer | Wallpaper ID |
| `modelType` | integer | Device type. Values: 0-Phone, 1-Tablet, 2-Computer |
| `udid` | string | Device UDID |
| `imei` | string | IMEI |
| `meid` | string | MEID |
| `phoneNumber` | string | SIM 1 phone number |
| `currentCarrierNetwork` | string | SIM 1 carrier |
| `imei2` | string | IMEI 2 |
| `phoneNumber2` | string | SIM 2 phone number |
| `currentCarrierNetwork2` | string | SIM 2 carrier |
| `allowType` | string | Permission settings JSON string containing: allowAppTrust, allowProfileInstall, allowEraseContent, allowUsb, forceAutomaticDateAndTime, allowVPNCreation |
| `productName` | string | Device model identifier |
| `lossStatus` | integer | Loss status. Values: 0-Not locked, 1-Lost mode set |
| `usbType` | integer | USB restriction. Values: 0-No, 1-Yes |
| `allowImage` | integer | Wallpaper modification permission. Values: 0-Allowed, 1-Not allowed |
| `allowAppType` | integer | App restriction removal. Values: 0-Allow only, 1-Remove all restrictions |
| `apps` | string | Apps JSON string |
| `lockEndTime` | string | Computer lock end time |
| `isDel` | integer | Deletion status. Values: 0-Normal, 1-Retired, 2-Deleted/managed |
| `createdAt` | string | Creation time |
| `lastTime` | string | Last communication time |
| `updatedAt` | string | Update time |
| `times` | string | Last communication duration |
| `osVersion` | string | System version |
| `lastIp` | null | Last IP address |
| `createBy` | integer | Creator ID |
| `createByName` | null | Creator name |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": {
    "id": 107018,
    "deviceId": "H6Q7JDQ9WQ",
    "userId": 531,
    "deviceName": "iPhone 13",
    "account": null,
    "companyName": null,
    "userName": null,
    "name": "",
    "phone": "",
    "deviceLock": 1,
    "status": 2,
    "imageId": 101,
    "modelType": 0,
    "udid": "00008110-0012755A3CE1801E",
    "imei": "35 305718 422724 0",
    "meid": "35305718422724",
    "phoneNumber": "",
    "currentCarrierNetwork": "",
    "imei2": "35 305718 404508 9",
    "phoneNumber2": "",
    "currentCarrierNetwork2": "",
    "allowType": "{\"allowAppTrust\":1,\"allowProfileInstall\":1,\"allowEraseContent\":1,\"allowUsb\":1,\"forceAutomaticDateAndTime\":1,\"allowVPNCreation\":1}",
    "productName": "iPhone14,5",
    "lossStatus": 0,
    "usbType": 1,
    "allowImage": 0,
    "allowAppType": 1,
    "apps": "",
    "lockEndTime": "",
    "isDel": 2,
    "createdAt": "2024-02-05 11:13:45",
    "lastTime": "2024-01-10 11:28:45",
    "updatedAt": "2024-02-21 11:03:54",
    "times": "44天4小时26分钟",
    "osVersion": "17.3",
    "lastIp": null,
    "createBy": 531,
    "createByName": null
  }
}
```

---

#### Get Device Information (Check Device)
- **Method:** `POST`
- **Path:** `/api/mdm/devices/get-info`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345
}
```

**Response Example:**
```json
{
  "code": 200,
  "msg": "Operation successful"
}
```

---

#### Device Update
- **Method:** `POST`
- **Path:** `/api/mdm/devices/update`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `idList` | array | List of device IDs |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "idList": [
    35,
    36,
    45,
    81
  ]
}
```

**Response Example:**
```json
{
  "msg": "Update successful",
  "code": 200
}
```

---

#### Device Lock
- **Method:** `POST`
- **Path:** `/api/mdm/devices/lock`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `message` | string | Lock screen message |
| `pin` | string | PIN code |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "message": "Device locked by administrator",
  "pin": "1234"
}
```

**Response Example:**
```json
{
  "msg": "Computer lock successful",
  "code": 200
}
```

---

#### Query Device Phone Number
- **Method:** `GET`
- **Path:** `/api/mdm/devices/phone`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `type` | integer | SIM card type. Values: 1-SIM 1, 2-SIM 2 |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Device phone number |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "13655544441",
  "code": 200
}
```

---

#### Query Device Phone History
- **Method:** `GET`
- **Path:** `/api/mdm/devices/phone/history`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `success` | boolean | Operation success status |
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | array | Array of phone history objects |
| `Name` | Type | Description |
| `phoneNumber` | string | Phone number |
| `currentCarrierNetwork` | string | Carrier name |
| `createTime` | string | Creation time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "code": 200,
  "msg": "Operation successful",
  "data": [
    {
      "phoneNumber": "+821912191****",
      "currentCarrierNetwork": "China Telecom",
      "createTime": "2023-11-23 15:50:27"
    }
  ],
  "success": true
}
```

---

#### Get Device Location
- **Method:** `GET`
- **Path:** `/api/mdm/devices/location`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `total` | integer | Total number of records |
| `rows` | array | Array of location objects |
| `code` | integer | Status code |
| `Name` | Type | Description |
| `altitude` | string | Altitude |
| `course` | string | Course/direction |
| `horizontalAccuracy` | string | Horizontal accuracy |
| `longitude` | string | Longitude |
| `latitude` | string | Latitude |
| `speed` | string | Movement speed |
| `verticalAccuracy` | string | Vertical accuracy |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "total": 1,
  "rows": [
    {
      "altitude": "50.5",
      "course": "180.0",
      "horizontalAccuracy": "10.0",
      "longitude": "116.4074",
      "latitude": "39.9042",
      "speed": "0.0",
      "verticalAccuracy": "5.0"
    }
  ],
  "code": 200
}
```

---

### Apps

#### Get App List
- **Method:** `GET`
- **Path:** `/api/mdm/apps`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `name` | string | App name filter |
| `pageNum` | integer | Page number |
| `pageSize` | integer | Page size |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `total` | integer | Total number of apps |
| `rows` | array | Array of app objects |
| `code` | integer | Status code |
| `Name` | Type | Description |
| `id` | integer | App ID |
| `name` | string | App name |
| `bundleId` | string | Bundle identifier |
| `icon` | string | Icon URL |
| `sort` | integer | Sort order |
| `createdAt` | string | Creation time |
| `updatedAt` | string | Update time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "total": 47,
  "rows": [
    {
      "id": 19,
      "name": "支付宝",
      "bundleId": "com.alipay.iphoneclient",
      "icon": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/2024/01/05/6d854574c8e24a068b4f2614cb239736支付宝.png",
      "sort": 1,
      "createdAt": "2024-01-06T17:35:48.000+08:00",
      "updatedAt": "2024-01-06T17:35:48.000+08:00"
    },
    {
      "id": 20,
      "name": "QQ",
      "bundleId": "com.tencent.mqq",
      "icon": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/2024/01/05/8774737ae1d740b5b359b2bd8c9e711bQQ.png",
      "sort": 2,
      "createdAt": "2024-01-06T17:35:51.000+08:00",
      "updatedAt": "2024-01-06T17:35:51.000+08:00"
    },
    {
      "id": 18,
      "name": "微信",
      "bundleId": "com.tencent.xin",
      "icon": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/2024/01/06/727ba6e3939945a3880d7412c57c04bb2c6dbd3fa14346380e32e469da0febb.png",
      "sort": 3,
      "createdAt": "2024-01-06T17:36:49.000+08:00",
      "updatedAt": "2024-01-06T17:36:49.000+08:00"
    }
  ],
  "code": 200
}
```

---

#### App Restriction Policy (Add App Restriction)
- **Method:** `POST`
- **Path:** `/api/mdm/apps/restrictions`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `allowAppType` | integer | App restriction removal. Values: 0-Allow only, 1-Not allowed |
| `id` | integer | Device ID |
| `appIdList` | array | List of app IDs |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "allowAppType": 0,
  "id": 213541,
  "appIdList": [
    19,
    20
  ]
}
```

**Response Example:**
```json
{
  "msg": "App restriction command sent successfully",
  "code": 200
}
```

---

#### Query Saved App List
- **Method:** `GET`
- **Path:** `/api/mdm/devices/apps/{id}`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `data` | array | Array of app objects |
| `Name` | Type | Description |
| `id` | integer | App ID |
| `name` | string | App name |
| `bundleId` | string | Bundle identifier |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": [
    {
      "id": 19,
      "name": "支付宝",
      "bundleId": "com.alipay.iphoneclient"
    }
  ]
}
```

---

#### Install App
- **Method:** `POST`
- **Path:** `/api/mdm/apps/install`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `type` | integer | Installation type. Values: 1-App Store, 2-Non-App Store |
| `appId` | integer | App ID |
| `appUrl` | string | App URL |
| `id` | integer | Device ID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "type": 1,
  "appId": 19,
  "appUrl": "https://apps.apple.com/app/alipay/id333206289",
  "id": 12345
}
```

**Response Example:**
```json
{
  "msg": "Install app command sent successfully",
  "code": 200
}
```

---

### Security

#### Set Lost Mode
- **Method:** `POST`
- **Path:** `/api/mdm/devices/lost-mode`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `dialPhone` | string | Contact phone number |
| `message` | string | Lock screen message |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "dialPhone": "+1234567890",
  "message": "This device is lost. Please call +1234567890 if found."
}
```

**Response Example:**
```json
{
  "msg": "Lost device command sent successfully",
  "code": 200
}
```

---

#### Remove Lost Mode
- **Method:** `POST`
- **Path:** `/api/mdm/devices/lost-mode/disable`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "Unlock command sent successfully",
  "code": 200
}
```

---

#### Send Activation Lock
- **Method:** `POST`
- **Path:** `/api/mdm/devices/activation-lock`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device business ID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345
}
```

**Response Example:**
```json
{
  "msg": "Activation lock command sent successfully",
  "code": 200
}
```

---

#### Update System
- **Method:** `POST`
- **Path:** `/api/mdm/devices/update-system`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device business ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 84,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "Update system command sent successfully",
  "code": 200
}
```

---

#### Query Device Activation Lock
- **Method:** `GET`
- **Path:** `/api/mdm/devices/activation-lock/query`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Device activation lock password |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "1",
  "code": 200
}
```

---

#### Remove Lock Screen Password
- **Method:** `POST`
- **Path:** `/api/mdm/devices/lock-screen-password`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "Operation command sent successfully",
  "code": 200
}
```

---

#### Send Remove Activation Lock Command
- **Method:** `POST`
- **Path:** `/api/mdm/devices/activation-lock/remove`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `subPassword` | string | Secondary password |
| `imei` | string | IMEI |
| `imei2` | string | IMEI 2 |
| `meid` | string | MEID |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "subPassword": "secondaryPassword123",
  "imei": "35 687621 025447 3",
  "imei2": "35 687621 025448 4",
  "meid": "35687621025447"
}
```

**Response Example:**
```json
{
  "msg": "Operation command sent successfully",
  "code": 200
}
```

---

### Policies

#### Restriction Policy (Install Profile)
- **Method:** `POST`
- **Path:** `/api/mdm/restrictions`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device business ID |
| `subPassword` | string | Secondary password |
| `allowAccountModification` | integer | Allow Apple ID modification. Values: 0-No, 1-Yes |
| `allowAppTrust` | integer | Allow app trust. Values: 0-No, 1-Yes |
| `allowEraseContent` | integer | Allow content erase. Values: 0-No, 1-Yes |
| `allowFindMyDevice` | integer | Allow Find My Device. Values: 0-No, 1-Yes |
| `allowProfileInstall` | integer | Allow profile installation. Values: 0-No, 1-Yes |
| `allowUsb` | integer | Allow USB. Values: 0-No, 1-Yes |
| `allowVpnCreation` | integer | Allow VPN. Values: 0-No, 1-Yes |
| `forceAutomaticDateAndTime` | integer | Allow time modification. Values: 0-No, 1-Yes |
| `forceEncryptedBackup` | integer | Encrypted backup. Values: 0-Yes, 1-No |
| `dns` | integer | Allow DNS. Values: 0-No, 1-Yes |
| `allowWebDistributionAppInstallation` | integer | Allow web app installation. Values: 0-No, 1-Yes |
| `allowItunesFileSharing` | integer | Allow app USB access. Values: 0-No, 1-Yes |
| `forceWiFiPowerOn` | integer | Force WiFi power on. Values: 0-No, 1-Yes |
| `allowAssistantWhileLocked` | integer | Allow Siri when locked. Values: 0-No, 1-Yes |
| `allowUntrustedTLSPrompt` | integer | Allow untrusted TLS. Values: 0-No, 1-Yes |
| `allowMarketplaceAppInstallation` | integer | Allow marketplace apps. Values: 0-No, 1-Yes |
| `allowUnpairedExternalBootToRecovery` | integer | Allow unpaired recovery. Values: 0-Yes, 1-No |
| `allowLockScreenTodayView` | integer | Allow Today view on lock screen. Values: 0-No, 1-Yes |
| `allowBluetoothModification` | integer | Allow Bluetooth settings. Values: 0-No, 1-Yes |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 72,
  "allowAccountModification": 0,
  "allowUsb": 1,
  "allowProfileInstall": 0,
  "allowFindMyDevice": 1,
  "allowEraseContent": 0,
  "allowAppTrust": 1,
  "forceAutomaticDateAndTime": 1,
  "allowVpnCreation": 0,
  "forceEncryptedBackup": 0,
  "dns": 1,
  "allowWebDistributionAppInstallation": 0,
  "allowItunesFileSharing": 1,
  "forceWiFiPowerOn": 1,
  "allowAssistantWhileLocked": 0,
  "allowUntrustedTLSPrompt": 0,
  "allowMarketplaceAppInstallation": 0,
  "allowUnpairedExternalBootToRecovery": 0,
  "allowLockScreenTodayView": 1,
  "allowBluetoothModification": 0,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "Operation command sent successfully",
  "code": 200
}
```

---

#### Set Lock Screen Wallpaper
- **Method:** `POST`
- **Path:** `/api/mdm/wallpaper/set`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `allowImage` | integer | User modification permission. Values: 0-Allow user modification, 1-Prevent user modification |
| `id` | integer | Device ID |
| `imageId` | integer | Wallpaper ID |
| `type` | integer | Operation type. Values: 1-Lock screen, 2-Home screen, 3-Both |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "allowImage": 0,
  "id": 12345,
  "imageId": 101,
  "type": 1
}
```

**Response Example:**
```json
{
  "msg": "Set image successful",
  "code": 200
}
```

---

#### Query Wallpaper List
- **Method:** `GET`
- **Path:** `/api/mdm/wallpapers`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `data` | array | Array of wallpaper objects |
| `Name` | Type | Description |
| `id` | integer | Wallpaper ID |
| `userId` | integer | User ID |
| `name` | string | Wallpaper name |
| `text` | string | Wallpaper image URL |
| `type` | integer | Type |
| `createdAt` | string | Creation time |
| `updatedAt` | string | Last modification time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": [
    {
      "id": 101,
      "userId": 531,
      "name": "Overdue",
      "text": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/golang/new.admin.mdm.zu5.cc/逾期.jpg",
      "type": 1,
      "createdAt": "2023-04-29T15:46:23.000+08:00",
      "updatedAt": "2023-04-29T15:46:35.000+08:00"
    },
    {
      "id": 104,
      "userId": 531,
      "name": "Natural Scenery",
      "text": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/golang/new.admin.mdm.zu5.cc/风景.jpg",
      "type": 1,
      "createdAt": "2023-04-29T15:49:04.000+08:00",
      "updatedAt": "2023-04-29T15:49:04.000+08:00"
    },
    {
      "id": 4084,
      "userId": 531,
      "name": "Overdue",
      "text": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/2023/12/21/caa86b4d13424683a13e5eab116796b6蓝 (2).png",
      "type": 1,
      "createdAt": "2023-12-21T10:50:29.000+08:00",
      "updatedAt": "2023-12-21T10:50:29.000+08:00"
    },
    {
      "id": 4152,
      "userId": 531,
      "name": "Wallpaper",
      "text": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/2024/01/11/e7b1979362ab4511993b4c609eed257a壁纸",
      "type": 1,
      "createdAt": "2024-01-11T12:02:30.000+08:00",
      "updatedAt": "2024-01-11T12:02:30.000+08:00"
    }
  ]
}
```

---

#### Query Wallpaper by ID
- **Method:** `GET`
- **Path:** `/api/mdm/wallpapers/{id}`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `data` | object | Wallpaper object |
| `Name` | Type | Description |
| `id` | integer | Wallpaper ID |
| `userId` | integer | User ID |
| `name` | string | Wallpaper name |
| `text` | string | Image URL |
| `type` | integer | Type |
| `createdAt` | string | Creation time |
| `updatedAt` | string | Last modification time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": {
    "id": 101,
    "userId": 531,
    "name": "Overdue",
    "text": "https://newd8f.oss-cn-hangzhou.aliyuncs.com/golang/new.admin.mdm.zu5.cc/逾期.jpg",
    "type": 1,
    "createdAt": "2023-04-29T15:46:23.000+08:00",
    "updatedAt": "2023-04-29T15:46:35.000+08:00"
  }
}
```

---

#### Set Lock Screen Text
- **Method:** `POST`
- **Path:** `/api/mdm/devices/lock-screen-text`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `assetTagInformation` | string | Backend information (asset tag) |
| `ifLostReturnToMessage` | string | Front message (lost return information) |
| `endTime` | string | End time |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `msg` | string | Response message |
| `code` | integer | Status code |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "id": 12345,
  "assetTagInformation": "Property of Company XYZ - Asset #12345",
  "ifLostReturnToMessage": "If found, please return to: 555-0123",
  "endTime": "2024-12-31 23:59:59"
}
```

**Response Example:**
```json
{
  "msg": "Operation command sent successfully",
  "code": 200
}
```

---

#### Query Device Restrictions
- **Method:** `GET`
- **Path:** `/api/mdm/restrictions/{id}`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `` |  | Maximum requests allowed per hour |
| `` |  | Number of requests remaining in current window |
| `` |  | Unix timestamp when the rate limit resets |

**Response Example:**
```json
{
  "data": {
    "allowAccountModification": 0,
    "allowAppTrust": 1,
    "allowEraseContent": 0,
    "allowFindMyDevice": 1,
    "allowProfileInstall": 0,
    "allowUsb": 1,
    "allowVpnCreation": 0,
    "forceAutomaticDateAndTime": 1,
    "forceEncryptedBackup": 0,
    "dns": 1,
    "allowWebDistributionAppInstallation": 0,
    "allowItunesFileSharing": 1,
    "forceWiFiPowerOn": 1,
    "allowAssistantWhileLocked": 0,
    "allowUntrustedTLSPrompt": 0,
    "allowMarketplaceAppInstallation": 0,
    "allowUnpairedExternalBootToRecovery": 0,
    "allowLockScreenTodayView": 1,
    "allowBluetoothModification": 0
  },
  "code": 200,
  "msg": "Operation successful"
}
```

---

### Verification

#### Set Secondary Password
- **Method:** `POST`
- **Path:** `/api/mdm/password/secondary`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `smsCode` | string | SMS verification code |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "smsCode": "123456",
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "code": 200,
  "msg": "Operation successful"
}
```

---

#### Check Secondary Password Verification Required
- **Method:** `GET`
- **Path:** `/api/mdm/password/verify-required`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | boolean | Verification required status |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": true
}
```

---

#### Send Verification Code
- **Method:** `GET`
- **Path:** `/api/mdm/verification/send`

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `data` | boolean | Operation success status |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "msg": "Operation successful",
  "code": 200,
  "data": true
}
```

---

#### Modify Account Phone Number
- **Method:** `POST`
- **Path:** `/api/mdm/phone/modify`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `phoneNumber` | string | New phone number |
| `codePar` | string | Verification code |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `code` | integer | Status code |
| `msg` | string | Response message |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Request Example:**
```json
{
  "phoneNumber": "+1234567890",
  "codePar": "123456"
}
```

**Response Example:**
```json
{
  "code": 200,
  "msg": "Verification successful"
}
```

---

### Operations

#### Query Device Operation Records
- **Method:** `GET`
- **Path:** `/api/mdm/devices/operations`

**Query Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Device ID |
| `type` | integer | Log type. Values: 1-Send lost device command, 2-Send remove lost command, 3-Send app restriction command, 4-Send restriction policy command, 5-Send activation lock command, 6-Send remove supervision command, 7-Send one-click unlock command, 0-All |
| `pageNum` | integer | Page number |
| `pageSize` | integer | Page size |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `total` | integer | Total number of records |
| `rows` | array | Array of operation record objects |
| `code` | integer | Status code |
| `Name` | Type | Description |
| `id` | integer | Log ID |
| `userId` | integer | User ID |
| `mdmId` | integer | Device ID |
| `deviceId` | string | Device serial number |
| `name` | string | Command name |
| `createdAt` | string | Creation time |
| `X-RateLimit-Limit` | Maximum requests allowed per hour |  |
| `X-RateLimit-Remaining` | Number of requests remaining in current window |  |
| `X-RateLimit-Reset` | Unix timestamp when the rate limit resets |  |

**Response Example:**
```json
{
  "total": 35,
  "rows": [
    {
      "id": 264378,
      "userId": 531,
      "mdmId": 62570,
      "deviceId": "G0NDQ2DF0D5R",
      "name": "Change restriction policy command",
      "createdAt": "2024-01-30 10:03:17"
    },
    {
      "id": 264377,
      "userId": 531,
      "mdmId": 62570,
      "deviceId": "G0NDQ2DF0D5R",
      "name": "Change restriction policy command",
      "createdAt": "2024-01-30 10:02:36"
    },
    {
      "id": 264027,
      "userId": 531,
      "mdmId": 62570,
      "deviceId": "G0NDQ2DF0D5R",
      "name": "Send update iOS system command",
      "createdAt": "2024-01-11 18:39:44"
    },
    {
      "id": 264014,
      "userId": 531,
      "mdmId": 62570,
      "deviceId": "G0NDQ2DF0D5R",
      "name": "Send update iOS system command",
      "createdAt": "2024-01-11 18:33:12"
    },
    {
      "id": 263957,
      "userId": 531,
      "mdmId": 62570,
      "deviceId": "G0NDQ2DF0D5R",
      "name": "Send app restriction command",
      "createdAt": "2024-01-08 17:33:55"
    }
  ],
  "code": 200
}
```

---

### Advanced

#### One Click Unlock
- **Method:** `POST`
- **Path:** `/api/mdm/devices/unlock`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Business ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `` |  | Maximum requests allowed per hour |
| `` |  | Number of requests remaining in current window |
| `` |  | Unix timestamp when the rate limit resets |

**Request Example:**
```json
{
  "id": 327810,
  "subPassword": "123456"
}
```

**Response Example:**
```json
{
  "msg": "One-click unlock command sent successfully",
  "code": 200
}
```

---

#### Unbind ABM
- **Method:** `POST`
- **Path:** `/api/mdm/devices/abm/unbind`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Business ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `` |  | Maximum requests allowed per hour |
| `` |  | Number of requests remaining in current window |
| `` |  | Unix timestamp when the rate limit resets |

**Request Example:**
```json
{
  "id": 12345,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "ABM unbind command sent successfully",
  "code": 200
}
```

---

#### Erase Device
- **Method:** `POST`
- **Path:** `/api/mdm/devices/erase`

**Request Parameters:**
| Name | Type | Description |
|---|---|---|
| `id` | integer | Business ID |
| `subPassword` | string | Secondary password |

**Response Fields:**
| Name | Type | Description |
|---|---|---|
| `` |  | Maximum requests allowed per hour |
| `` |  | Number of requests remaining in current window |
| `` |  | Unix timestamp when the rate limit resets |

**Request Example:**
```json
{
  "id": 12345,
  "subPassword": "secondaryPassword123"
}
```

**Response Example:**
```json
{
  "msg": "Erase device command sent successfully",
  "code": 200
}
```

---

