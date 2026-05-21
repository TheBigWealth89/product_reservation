import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from project root
const rootPath = path.join(__dirname, "../../");

if (process.env.NODE_ENV === "test") {
  dotenv.config({ path: path.join(rootPath, ".env.test") });
} else {
  dotenv.config({ path: path.join(rootPath, ".env") });
}
