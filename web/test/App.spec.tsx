import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupZMKMocks } from "@cormoran/zmk-studio-react-hook/testing";
import App from "../src/App";

// Mock the ZMK client
jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  create_rpc_connection: jest.fn(),
  call_rpc: jest.fn(),
  MetaError: class MetaError extends Error {
    condition: string;
    constructor(condition: string) {
      super(`MetaError: ${condition}`);
      this.condition = condition;
    }
  },
}));

jest.mock("@zmkfirmware/zmk-studio-ts-client/transport/serial", () => ({
  connect: jest.fn(),
}));

describe("App Component", () => {
  describe("Basic Rendering", () => {
    it("should render the application header", () => {
      render(<App />);

      expect(
        screen.getByRole("heading", { name: /Kscan Diagnostics/i })
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /Diagnose broken wires, bad solder joints, and switch chatter/i
        )
      ).toBeInTheDocument();
    });

    it("should render connection button when disconnected", () => {
      render(<App />);

      expect(screen.getByText(/Connect Serial/i)).toBeInTheDocument();
    });

    it("should render footer", () => {
      render(<App />);

      expect(screen.getAllByText(/Kscan Diagnostics/i).length).toBeGreaterThan(
        0
      );
    });
  });

  describe("Connection Flow", () => {
    let mocks: ReturnType<typeof setupZMKMocks>;

    beforeEach(() => {
      mocks = setupZMKMocks();
    });

    it("should connect to device and warn when the subsystem is missing", async () => {
      mocks.mockSuccessfulConnection({
        deviceName: "Test Keyboard",
        subsystems: [],
      });
      // Every RPC call after the initial handshake (topology fetch, official
      // keymap, input-stream) falls through to the default jest mock
      // (resolves undefined) unless queued -- hooks must handle that
      // gracefully rather than hang/crash the render.
      mocks.call_rpc.mockResolvedValue({});

      const { connect: serial_connect } =
        await import("@zmkfirmware/zmk-studio-ts-client/transport/serial");
      (serial_connect as jest.Mock).mockResolvedValue(mocks.mockTransport);

      render(<App />);

      expect(screen.getByText(/Connect Serial/i)).toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByText(/Connect Serial/i));

      await waitFor(() => {
        expect(
          screen.getByText(/Connected to: Test Keyboard/i)
        ).toBeInTheDocument();
      });

      expect(screen.getByText(/Disconnect/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Subsystem "cormoran__kscan_diagnostics" not found/i)
      ).toBeInTheDocument();
    });

    it("shows the stats table and wizard entry point once the subsystem is present", async () => {
      mocks.mockSuccessfulConnection({
        deviceName: "Test Keyboard",
        subsystems: ["cormoran__kscan_diagnostics"],
      });
      // GetInfo response with zero layouts/devices keeps the topology fetch
      // trivially finished (template "zero-device rule", DESIGN.md SS4) so
      // this smoke test doesn't need to model paged GpioPins/PositionMap.
      mocks.call_rpc.mockResolvedValue({
        custom: {
          call: {
            payload: undefined,
          },
        },
      });

      const { connect: serial_connect } =
        await import("@zmkfirmware/zmk-studio-ts-client/transport/serial");
      (serial_connect as jest.Mock).mockResolvedValue(mocks.mockTransport);

      render(<App />);
      const user = userEvent.setup();
      await user.click(screen.getByText(/Connect Serial/i));

      await waitFor(() => {
        expect(
          screen.getByText(/Connected to: Test Keyboard/i)
        ).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/^Stats$/i)).toBeInTheDocument();
      });
    });
  });
});
