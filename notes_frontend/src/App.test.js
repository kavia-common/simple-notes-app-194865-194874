import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders notes app header", () => {
  render(<App />);
  expect(screen.getByText(/notes/i)).toBeInTheDocument();
});
