import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

// The secrets this tool reads from the environment. A value typed after `export NAME=` lands in shell history.
const SECRETS = ["SPOTIFY_CLIENT_SECRET", "SUPABASE_SECRET_KEY", "SPOTIFY_REFRESH_TOKEN"];

describe("the README keeps secrets out of shell history", () => {
  it.each(SECRETS)("never shows `export %s=`, in any form", (name) => {
    expect(readme).not.toMatch(new RegExp(`export\\s+(?:[A-Z_]+=\\S*\\s+)*${name}=`));
    expect(readme).not.toMatch(new RegExp(`^\\s*${name}=`, "m"));
  });

  it.each(SECRETS.filter((name) => name !== "SPOTIFY_REFRESH_TOKEN"))("shows a silent read for %s", (name) => {
    expect(readme).toContain(`read -rs ${name}; export ${name}`);
  });

  it("tells the reader the same holds for any value typed in a terminal", () => {
    expect(readme).toMatch(/any (secret )?value (you )?type[d]? in a terminal/i);
  });

  it("says that a feature needing more scopes means logging in again, which restarts the six month clock", () => {
    expect(readme).toMatch(/more scopes/i);
    expect(readme).toMatch(/run `?spotify-login`? again|run the login again/i);
    expect(readme).toMatch(/six month/i);
    expect(readme).toContain("LATER_LOGIN_SCOPES");
  });

  it("tells the reader to clear the scrollback after copying the token", () => {
    expect(readme).toContain("clear && printf '\\e[3J'");
  });
});
