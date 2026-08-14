export function BrandWelcome() {
  return (
    <section className="aq-brand-welcome" aria-labelledby="aq-home-title">
      <div className="aq-brand-welcome__copy">
        <h1 id="aq-home-title" tabIndex={-1}>
          <span className="aq-brand-welcome__cn">光阴砚</span>
          <span className="aq-brand-welcome__en">AEONQUILL</span>
        </h1>
        <span className="aq-brand-welcome__rule" aria-hidden="true" />
        <p className="aq-brand-welcome__line">以光为墨，以时为卷。</p>
        <p className="aq-brand-welcome__line">一念落砚，万象成章。</p>
        <p className="aq-brand-welcome__english">Shape Light. Weave Time.</p>
      </div>
      <div className="aq-brand-welcome__art" aria-hidden="true" />
    </section>
  )
}
