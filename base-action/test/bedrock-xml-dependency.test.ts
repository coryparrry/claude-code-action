import { describe, expect, test } from "bun:test";
import { parseXML } from "@aws-sdk/xml-builder";

describe("AWS XML adapter compatibility", () => {
  test("parses AWS credential responses with the patched parser", () => {
    expect(
      parseXML(`<AssumeRoleResponse>
      <AssumeRoleResult><Credentials>
        <AccessKeyId>offline-access</AccessKeyId>
        <SecretAccessKey>offline-secret</SecretAccessKey>
        <SessionToken>offline&amp;session</SessionToken>
      </Credentials></AssumeRoleResult>
    </AssumeRoleResponse>`),
    ).toEqual({
      AssumeRoleResponse: {
        AssumeRoleResult: {
          Credentials: {
            AccessKeyId: "offline-access",
            SecretAccessKey: "offline-secret",
            SessionToken: "offline&session",
          },
        },
      },
    });
  });

  test("preserves AWS numeric character references", () => {
    expect(parseXML("<Value>first&#xD;second&#10;third</Value>")).toEqual({
      Value: "first\rsecond\nthird",
    });
  });

  test("handles invalid numeric entities without a RangeError", () => {
    expect(parseXML("<Value>&#9999999;</Value>")).toEqual({
      Value: "&#9999999;",
    });
  });

  test("rejects regex characters in declared entity names", () => {
    expect(() =>
      parseXML(
        '<!DOCTYPE root [<!ENTITY .* "replacement">]><root>&lt;safe&gt;</root>',
      ),
    ).toThrow("Invalid entity name");
  });
});
