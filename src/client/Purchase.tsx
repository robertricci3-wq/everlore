import { useEffect, useState } from "react";
import { api } from "./api.js";
type OrderView = {
  id: string;
  projectId: string;
  status: string;
  amountCents: number;
  checkoutUrl: string | null;
  error: string | null;
  taxCents: number | null;
  refundedCents: number;
  totalCents: number | null;
  receiptUrl: string | null;
  canRenew: boolean;
  tracking: {
    id: string;
    status: string;
    carrier: string | null;
    number: string | null;
    url: string | null;
  }[];
};
type PurchaseView = {
  reasons: string[];
  priceCents: number | null;
  format: string;
  bundle: {
    id: string;
    version: number;
    pageCount: number;
    ready: boolean;
    issues: string[];
  } | null;
  order: OrderView | null;
};
const money = (c: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
const labels: Record<string, string> = {
  creating_checkout: "Preparing secure checkout",
  checkout_request_sent: "Connecting to checkout",
  awaiting_payment: "Ready for payment",
  checkout_expired: "Your previous checkout expired. No payment was taken.",
  cancelled: "The printer cancelled this order. We are here to help.",
  provider_failed: "The printer needs help with this order.",
  refund_pending: "Your refund is being checked",
  refunded: "Your payment has been refunded",
  paid: "Payment received. Preparing your book for the printer.",
  dispatching: "Sending your book to the printer",
  submitted: "Your book is with the printer",
  shipped: "Your book has shipped",
  needs_attention:
    "Your order needs attention. Please do not place another order.",
};
export function Purchase({
  projectId,
  editionId,
}: {
  projectId: string;
  editionId: string;
}) {
  const [data, setData] = useState<PurchaseView | null>(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0),
    [error, setError] = useState("");
  const url = `/projects/${projectId}/editions/${editionId}`;
  useEffect(() => {
    let alive = true;
    void api<PurchaseView>(`${url}/purchase`)
      .then((v) => {
        if (alive) setData(v);
      })
      .catch(() => {
        if (alive) setError("Hardcover availability could not be loaded.");
      });
    return () => {
      alive = false;
    };
  }, [url]);
  const act = async (checkout: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (checkout) {
        const o = await api<OrderView>(`${url}/checkout`, {});
        location.hash = `/order/${o.id}`;
        if (o.checkoutUrl) location.assign(o.checkoutUrl);
      } else {
        await api(`${url}/prepare-print`, {});
        setData(await api<PurchaseView>(`${url}/purchase`));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="story-studio">
      <h2>A book to hold. A story to keep.</h2>
      <p>{data?.format ?? "Your illustrated family story, as a hardcover."}</p>
      {error && <p role="alert">{error}</p>}
      {data?.order ? (
        <a className="button" href={`#/order/${data.order.id}`}>
          View your order
        </a>
      ) : (
        <>
          {data?.priceCents ? (
            <p>
              {money(data.priceCents)} · standard US shipping included · tax
              calculated at checkout
            </p>
          ) : (
            <p>Hardcover pricing is being prepared.</p>
          )}
          {data?.reasons.length ? (
            <p>{data.reasons[0]} Your digital edition remains available.</p>
          ) : null}
          {data?.bundle?.issues.map((x) => (
            <p key={x}>{x}</p>
          ))}
          {data && !data.bundle?.ready && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void act(false)}
            >
              {busy
                ? "Preparing…"
                : data.bundle
                  ? "Check print readiness again"
                  : "Prepare this edition for print"}
            </button>
          )}
          {data?.bundle?.version === 2 && (
            <details>
              <summary>Preview the printed edition</summary>
              <img
                style={{ width: "100%", maxWidth: 600, display: "block" }}
                alt={`Printed book page ${page + 1}`}
                src={`/api/projects/${projectId}/print/${data.bundle.id}/preview/${page}`}
                loading="lazy"
              />
              <p>
                Page {page + 1} of {data.bundle.pageCount}
              </p>
              <button
                className="button secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous page
              </button>{" "}
              <button
                className="button secondary"
                disabled={page >= data.bundle.pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next page
              </button>
              <p>
                <a
                  href={`/api/projects/${projectId}/print/${data.bundle.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open print PDF
                </a>
              </p>
            </details>
          )}
          {data?.bundle?.ready && data.reasons.length === 0 && (
            <button
              className="button"
              disabled={busy}
              onClick={() => void act(true)}
            >
              {busy
                ? "Opening checkout…"
                : `Send me this book · ${money(data.priceCents!)}`}
            </button>
          )}
          <p className="small">
            Secure payment and delivery address entry through Stripe. We print
            the exact saved edition shown here.
          </p>
        </>
      )}
    </section>
  );
}
export function OrderPage({ id }: { id: string }) {
  const [data, setData] = useState<OrderView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [support, setSupport] = useState(""),
    [supportSent, setSupportSent] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api<OrderView>(`/orders/${id}`)
        .then((o) => {
          if (alive) setData(o);
        })
        .catch(() => {
          if (alive)
            setError("Please sign in to the shelf that purchased this book.");
        });
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      setData(await api<OrderView>(`/orders/${id}/refresh`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const renew = async () => {
    setBusy(true);
    setError("");
    try {
      const o = await api<OrderView>(`/orders/${id}/renew-checkout`, {});
      setData(o);
      if (o.checkoutUrl) location.assign(o.checkoutUrl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendSupport = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/orders/${id}/support`, { message: support });
      setSupportSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="narrow project-state">
      <h1>Your Everlore book</h1>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <h2>{labels[data.status] ?? "Your order is saved"}</h2>
          <p>
            {money(data.totalCents ?? data.amountCents)}{" "}
            {data.totalCents !== null ? "paid total" : "before tax"} · standard
            US shipping included
          </p>
          {data.taxCents !== null && (
            <p className="small">
              Book and shipping {money(data.amountCents)} · tax{" "}
              {money(data.taxCents)}
            </p>
          )}
          {data.refundedCents > 0 && (
            <p>Refunded {money(data.refundedCents)}</p>
          )}
          {data.receiptUrl && (
            <p>
              <a href={data.receiptUrl} target="_blank" rel="noreferrer">
                View payment receipt
              </a>
            </p>
          )}
          {data.tracking?.map((t, i) => (
            <p key={t.id || i}>
              {t.carrier ?? "Delivery"}: {t.status}
              {t.url ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={t.url} target="_blank" rel="noreferrer">
                    Track {t.number ?? "your parcel"}
                  </a>
                </>
              ) : t.number ? (
                ` · ${t.number}`
              ) : (
                ""
              )}
            </p>
          ))}
          {data.canRenew && (
            <button
              className="button"
              disabled={busy}
              onClick={() => void renew()}
            >
              Open a new secure checkout
            </button>
          )}
          {data.error && <p>{data.error}</p>}
          {data.checkoutUrl && (
            <a className="button" href={data.checkoutUrl}>
              Continue secure checkout
            </a>
          )}
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? "Checking…" : "Check payment or shipping status"}
          </button>
          <p>
            <a href={`#/story/${data.projectId}`}>Return to your book</a>
          </p>
          <p>
            <a href="#/orders">All your orders</a>
          </p>
          <details>
            <summary>Get help with this order</summary>
            {supportSent ? (
              <p role="status">
                Your request is saved with this order for our support team.
              </p>
            ) : (
              <>
                <label>
                  What can we help with?
                  <textarea
                    value={support}
                    onChange={(e) => setSupport(e.target.value)}
                    maxLength={2000}
                  />
                </label>
                <button
                  className="button secondary"
                  disabled={busy || support.trim().length < 10}
                  onClick={() => void sendSupport()}
                >
                  Send support request
                </button>
              </>
            )}
          </details>
          <p className="small">Order {data.id}</p>
        </>
      )}
    </main>
  );
}

export function OrderHistory() {
  const [orders, setOrders] = useState<OrderView[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    void api<OrderView[]>("/orders")
      .then(setOrders)
      .catch(() => setError("Sign in to see your orders."));
  }, []);
  return (
    <main className="narrow project-state">
      <h1>Your orders</h1>
      {error && <p role="alert">{error}</p>}
      {orders.length === 0 && !error && (
        <p>Your hardcover orders will appear here.</p>
      )}
      {orders.map((o) => (
        <section className="story-studio" key={o.id}>
          <h2>{labels[o.status] ?? "Your order is saved"}</h2>
          <p>{money(o.totalCents ?? o.amountCents)}</p>
          <a className="button secondary" href={`#/order/${o.id}`}>
            View order
          </a>
        </section>
      ))}
      <p>
        <a href="#/shelf">Your bookshelf</a>
      </p>
    </main>
  );
}
type OperationsView = {
  orders: (OrderView & {
    providerId: string | null;
    attempts: {
      id: string;
      sequence: number;
      status: string;
      sessionId: string | null;
      error: string | null;
    }[];
    refund: {
      status: string;
      amountCents: number;
      error: string | null;
    } | null;
  })[];
  support: {
    id: string;
    orderId: string;
    message: string;
    createdAt: string;
  }[];
};
export function CommerceOperations() {
  const [data, setData] = useState<OperationsView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [orderId, setOrderId] = useState(""),
    [kind, setKind] = useState("payment"),
    [providerId, setProviderId] = useState(""),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const load = () => api<OperationsView>("/operator/orders").then(setData);
  useEffect(() => {
    void load().catch(() => setError("Operator access is required."));
  }, []);
  const act = async (path: string, body: object) => {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      await load();
      setConfirmed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="narrow project-state">
      <h1>Orders and recovery</h1>
      <p>
        Reconciliation reads existing provider records. It never creates a
        replacement order.
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <section className="story-studio">
            <h2>Reconcile an order</h2>
            <label>
              Order
              <select
                value={orderId}
                onChange={(e) => {
                  setOrderId(e.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">Choose an order</option>
                {data.orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id} · {o.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Provider record
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="payment">Stripe checkout</option>
                <option value="print">Prodigi order</option>
                <option value="shipping">Shipping status</option>
                <option value="refund">Stripe refund</option>
              </select>
            </label>
            <label>
              Provider ID (optional for saved checkout or shipping)
              <input
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              />
            </label>
            <button
              className="button secondary"
              disabled={busy || !orderId}
              onClick={() =>
                void act(`/operator/orders/${orderId}/reconcile`, {
                  kind,
                  providerId,
                })
              }
            >
              Read and reconcile
            </button>
            <details>
              <summary>Issue a full refund</summary>
              <p>
                Refunding does not cancel a book already at the printer.
                Reconcile unknown printing outcomes first.
              </p>
              <label>
                Reason
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I intend to refund the full confirmed payment for this order.
              </label>
              <button
                className="button"
                disabled={busy || !orderId || !confirmed || !reason.trim()}
                onClick={() =>
                  void act(`/operator/orders/${orderId}/refund`, {
                    reason,
                    confirm: true,
                  })
                }
              >
                Issue full refund
              </button>
            </details>
          </section>
          <h2>Open support requests</h2>
          {data.support.length === 0 && <p>No open support requests.</p>}
          {data.support.map((t) => (
            <section className="story-studio" key={t.id}>
              <p>Order {t.orderId}</p>
              <p>{t.message}</p>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void act(`/operator/support/${t.id}/resolve`, {})
                }
              >
                Mark resolved
              </button>
            </section>
          ))}
          <h2>Retained order evidence</h2>
          {data.orders.map((o) => (
            <details key={o.id}>
              <summary>
                {o.id} · {o.status} · {money(o.totalCents ?? o.amountCents)}
              </summary>
              {o.error && <p>{o.error}</p>}
              <p>Printer: {o.providerId ?? "No confirmed order"}</p>
              {o.attempts.map((a) => (
                <p key={a.id}>
                  Checkout {a.sequence}: {a.status} ·{" "}
                  {a.sessionId ?? "Response unknown"}
                  {a.error ? ` · ${a.error}` : ""}
                </p>
              ))}
              {o.refund && (
                <p>
                  Refund: {o.refund.status} · {money(o.refund.amountCents)}{" "}
                  {o.refund.error}
                </p>
              )}
            </details>
          ))}
        </>
      )}
    </main>
  );
}
