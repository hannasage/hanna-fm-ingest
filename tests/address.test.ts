import { describe, expect, it } from "vitest";
import { addressProblem, spotifyAddressProblem } from "../src/address.ts";

describe("spotifyAddressProblem", () => {
  it.each([
    ["SPOTIFY_ACCOUNTS_BASE", "https://accounts.spotify.com", "accounts.spotify.com"],
    ["SPOTIFY_API_BASE", "https://api.spotify.com/v1", "api.spotify.com"],
    ["SPOTIFY_API_BASE", "http://127.0.0.1:5555", "api.spotify.com"],
    ["SPOTIFY_ACCOUNTS_BASE", "http://localhost:5555", "accounts.spotify.com"],
  ])("accepts %s = %s", (variable, address, host) => {
    expect(spotifyAddressProblem(variable, address, host)).toBeNull();
  });

  it.each([
    "https://evil.example",
    "https://api.spotify.com.evil.example",
    "https://evil.example/api.spotify.com",
    "https://user:pass@api.spotify.com",
    "https://api.spotify.com:8443",
    "http://api.spotify.com",
    "https://accounts.spotify.com",
    "https://localhost.evil.example",
    "ftp://127.0.0.1",
  ])("refuses %s for the API address", (address) => {
    expect(spotifyAddressProblem("SPOTIFY_API_BASE", address, "api.spotify.com")).toBe(
      "SPOTIFY_API_BASE must be https://api.spotify.com, or localhost or 127.0.0.1 for tests.",
    );
  });

  it("says not valid for an address that does not parse, without quoting it", () => {
    expect(spotifyAddressProblem("SPOTIFY_API_BASE", "not a url secret-value", "api.spotify.com")).toBe(
      "SPOTIFY_API_BASE is not a valid address.",
    );
  });
});

describe("addressProblem (the database address)", () => {
  it("still allows any https host, and plain http only for this computer", () => {
    expect(addressProblem("SUPABASE_URL", "https://project.example")).toBeNull();
    expect(addressProblem("SUPABASE_URL", "http://127.0.0.1:1")).toBeNull();
    expect(addressProblem("SUPABASE_URL", "http://example.com")).not.toBeNull();
  });
});
