import { describe, expect, it } from "bun:test";
import {
  assertTrustedRepository,
  repositoryProjectPath,
  type RepositoryTarget,
} from "../src/domain/repository.js";

const repository: RepositoryTarget = {
  forge: "gitlab",
  url: "https://gitlab.hlag.altemista.cloud/fis3/commons-ui/commons-ui-frontend.git",
};

describe("repository policy", () => {
  it("allows a repository whose URL starts with a trusted prefix", () => {
    expect(
      assertTrustedRepository(repository, ["https://gitlab.hlag.altemista.cloud/fis3/"]),
    ).toEqual(repository);
  });

  it("rejects a repository outside every trusted prefix", () => {
    expect(() => assertTrustedRepository(repository, ["https://github.com/example/"])).toThrow(
      "Repository URL is not trusted",
    );
  });

  it("derives nested GitLab project paths from the URL", () => {
    expect(repositoryProjectPath(repository)).toBe("fis3/commons-ui/commons-ui-frontend");
  });
});
