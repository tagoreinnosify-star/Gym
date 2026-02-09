import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import AllRepsCount from "./AllRepsCount.jsx";
import WithEndPoint from "./WithEndPoint.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <WithEndPoint />
  </StrictMode>,
);
