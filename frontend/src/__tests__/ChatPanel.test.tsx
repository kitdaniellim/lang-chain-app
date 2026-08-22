import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatPanel } from "../components/ChatPanel";

describe("ChatPanel", () => {
  it("titles the panel and keeps the suggestions without a description paragraph", () => {
    render(<ChatPanel llmConfigured model="claude-sonnet-5" />);

    expect(screen.getByRole("heading", { name: "Chat with our Agent" })).toBeInTheDocument();
    expect(screen.queryByText(/A LangChain agent writes the SQL/)).not.toBeInTheDocument();
    expect(screen.getByText("Pick a suggestion or ask your own question.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Which invoices are overdue?" })).toBeInTheDocument();
  });

  it("shows the model beside the composer label", () => {
    render(<ChatPanel llmConfigured model="claude-sonnet-5" />);

    expect(screen.getByLabelText("Your question")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
  });

  it("falls back to the key-missing label and disables the composer", () => {
    render(<ChatPanel llmConfigured={false} model={null} />);

    expect(screen.getByText("Claude: key missing")).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toBeDisabled();
  });
});
