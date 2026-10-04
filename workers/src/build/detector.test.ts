import { describe, expect, it } from "vitest";
import { detect } from "./detector.mjs";

// In-memory tree: each test describes the repo as a map of files.
function tree(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    read: (p: string) => (p in files ? files[p] : null),
  };
}

describe("stack detector", () => {
  it("a Dockerfile in the repo takes priority and is used as-is", () => {
    const result = detect(tree({ Dockerfile: "FROM scratch\n", "package.json": "{}" }));
    expect(result.kind).toBe("dockerfile");
    expect(result.dockerfile).toBe("FROM scratch\n");
  });

  it("Node with npm lockfile and start script", () => {
    const result = detect(
      tree({
        "package.json": JSON.stringify({ engines: { node: ">=20" }, scripts: { start: "node server.js" } }),
        "package-lock.json": "{}",
        "server.js": "",
      }),
    );
    expect(result.kind).toBe("node");
    expect(result.dockerfile).toContain("FROM node:20-alpine");
    expect(result.dockerfile).toContain("RUN npm ci");
    expect(result.dockerfile).toContain('CMD ["npm","start"]');
    expect(result.dockerfile).toContain("USER 1000");
    expect(result.justification).toContain("package-lock.json → npm ci");
  });

  it("Node with pnpm uses corepack and a frozen lockfile", () => {
    const result = detect(tree({ "package.json": JSON.stringify({ scripts: { start: "x" } }), "pnpm-lock.yaml": "" }));
    expect(result.dockerfile).toContain("RUN corepack enable && pnpm install --frozen-lockfile");
    expect(result.dockerfile).toContain('CMD ["pnpm","start"]');
  });

  it("Node without engines uses the default version and says so in the justification", () => {
    const result = detect(tree({ "package.json": "{}", "index.js": "" }));
    expect(result.dockerfile).toContain("FROM node:22-alpine");
    expect(result.justification.join(" ")).toMatch(/no engines.node/);
  });

  it("Node without start uses main or index.js as the entrypoint", () => {
    const result = detect(tree({ "package.json": JSON.stringify({ main: "app.js" }), "app.js": "" }));
    expect(result.dockerfile).toContain('CMD ["node","app.js"]');
  });

  it("Node with neither a script nor an entrypoint is unknown with a reason", () => {
    const result = detect(tree({ "package.json": "{}" }));
    expect(result.kind).toBe("unknown");
    expect(result.dockerfile).toBeNull();
    expect(result.justification.join(" ")).toMatch(/no scripts.start/);
  });

  it("invalid package.json is unknown", () => {
    const result = detect(tree({ "package.json": "{ not json" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/is not valid JSON/);
  });

  it("Python with requirements.txt and main.py", () => {
    const result = detect(tree({ "requirements.txt": "flask\n", "main.py": "" }));
    expect(result.kind).toBe("python");
    expect(result.dockerfile).toContain("FROM python:3.12-slim");
    expect(result.dockerfile).toContain("RUN pip install --no-cache-dir -r requirements.txt");
    expect(result.dockerfile).toContain('CMD ["python","main.py"]');
  });

  it("Python without a recognized entrypoint is unknown", () => {
    const result = detect(tree({ "requirements.txt": "flask\n" }));
    expect(result.kind).toBe("unknown");
  });

  it("Go uses the go.mod version and a multi-stage build", () => {
    const result = detect(tree({ "go.mod": "module x\n\ngo 1.22\n", "main.go": "" }));
    expect(result.kind).toBe("go");
    expect(result.dockerfile).toContain("FROM golang:1.22-alpine AS build");
    expect(result.dockerfile).toContain("COPY --from=build /out/app /app");
  });

  it("Go without main.go (library) is unknown", () => {
    const result = detect(tree({ "go.mod": "module x\n\ngo 1.22\n" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/library-only packages/);
  });

  it("a repo with no recognized stack file is unknown and asks for a Dockerfile", () => {
    const result = detect(tree({ "README.md": "" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/add a Dockerfile/);
  });

  it("Java/Maven with a declared java.version and Spring Boot", () => {
    const result = detect(
      tree({
        "pom.xml": `<project><properties><java.version>17</java.version></properties>
          <dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`,
      }),
    );
    expect(result.kind).toBe("java");
    expect(result.dockerfile).toContain("FROM maven:3.9-eclipse-temurin-17 AS build");
    expect(result.dockerfile).toContain("RUN mvn -B -DskipTests package");
    expect(result.dockerfile).toContain("FROM eclipse-temurin:17-jre-alpine");
    expect(result.dockerfile).toContain('CMD ["java","-jar","/app/app.jar"]');
    expect(result.justification.join(" ")).toMatch(/spring-boot-starter/);
  });

  it("Java/Maven without a declared version uses the default", () => {
    const result = detect(tree({ "pom.xml": "<project></project>" }));
    expect(result.dockerfile).toContain(`FROM maven:3.9-eclipse-temurin-21 AS build`);
  });

  it("Java/Gradle with sourceCompatibility", () => {
    const result = detect(tree({ "build.gradle": "sourceCompatibility = '21'\n" }));
    expect(result.kind).toBe("java");
    expect(result.dockerfile).toContain("FROM gradle:8-jdk21 AS build");
    expect(result.dockerfile).toContain("RUN gradle build -x test --no-daemon");
    expect(result.dockerfile).toContain("COPY --from=build /app/build/libs/*.jar /app/app.jar");
  });

  it("pom.xml takes priority over package.json (frontend assets alongside a Java backend)", () => {
    const result = detect(tree({ "pom.xml": "<project></project>", "package.json": "{}" }));
    expect(result.kind).toBe("java");
  });

  it("PHP/Laravel with composer.json", () => {
    const result = detect(
      tree({
        "composer.json": JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11.0" } }),
        "public/index.php": "",
      }),
    );
    expect(result.kind).toBe("php");
    expect(result.dockerfile).toContain("FROM php:8.2-cli-alpine");
    expect(result.dockerfile).toContain("COPY --from=composer:2 /usr/bin/composer /usr/bin/composer");
    expect(result.dockerfile).toContain('CMD ["php","-S","0.0.0.0:8080","-t","public"]');
    expect(result.justification.join(" ")).toMatch(/laravel\/framework/);
  });

  it("plain PHP without a framework uses the root as docroot", () => {
    const result = detect(tree({ "composer.json": "{}", "index.php": "" }));
    expect(result.kind).toBe("php");
    expect(result.dockerfile).toContain("FROM php:8.3-cli-alpine");
    expect(result.dockerfile).toContain('CMD ["php","-S","0.0.0.0:8080","-t","."]');
  });

  it("PHP without an index.php is unknown", () => {
    const result = detect(tree({ "composer.json": "{}" }));
    expect(result.kind).toBe("unknown");
  });

  it("invalid composer.json is unknown", () => {
    const result = detect(tree({ "composer.json": "{ not json" }));
    expect(result.kind).toBe("unknown");
    expect(result.justification.join(" ")).toMatch(/is not valid JSON/);
  });

  it("composer.json takes priority over package.json (frontend assets alongside a PHP backend)", () => {
    const result = detect(tree({ "composer.json": "{}", "index.php": "", "package.json": "{}" }));
    expect(result.kind).toBe("php");
  });
});
