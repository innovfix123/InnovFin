"""Tests for deterministic field extraction (Milestone 2.4)."""

from doctype.models import DocumentType
from extraction.models import ExtractedContent
from fields import FieldExtractor

_INV01 = {
    "Irn": "a1b2c3",
    "DocDtls": {"No": "INV-2026-501", "Dt": "06/07/2026"},
    "SellerDtls": {"Gstin": "27AABCU9603R1ZM", "LglNm": "Acme Supplies Pvt Ltd"},
    "BuyerDtls": {"Gstin": "29AAGCR1234M1Z5", "LglNm": "Innovfix Private Limited"},
    "ValDtls": {"AssVal": 10000, "CgstVal": 900, "SgstVal": 900, "TotInvVal": 11800},
    "ItemList": [{"HsnCd": "998314"}],
}

_TEXT = (
    "Tax Invoice\n"
    "Invoice No: INV-2026-777\n"
    "Invoice Date: 06/07/2026\n"
    "GSTIN: 27AABCU9603R1ZM\n"
    "HSN: 998314\n"
    "Taxable Value: 10,000.00\n"
    "CGST: 900.00  SGST: 900.00\n"
    "Grand Total: 11,800.00\n"
    "Due Date: 20/07/2026\n"
)


def _content(text="", structured=None, dtype=DocumentType.DIGITAL_PDF):
    return ExtractedContent("d1", "inv", dtype, "x", text, structured, 1.0, False, ())


def test_text_bare_date_and_no_decimal_amounts():
    # Real invoices often use a bare "Date" label and whole-number amounts (no decimals).
    f = FieldExtractor().extract(_content(
        "Tax Invoice No TEST-001 Date 07/07/2026\n"
        "GSTIN 27AABCU9603R1ZN\n"
        "Taxable 10000 CGST 900 SGST 900 Grand Total 11800"
    ))
    assert f.value("invoice_number") == "TEST-001"
    assert f.value("invoice_date") == "07/07/2026"
    assert f.value("taxable_value") == 10000.0
    assert f.value("cgst") == 900.0 and f.value("sgst") == 900.0
    assert f.value("total") == 11800.0


def test_text_month_name_date_and_date_of_issue_label():
    # Stripe/Anthropic-style: "Date of issue" label + "June 6, 2026" value on the next line.
    f = FieldExtractor().extract(_content(
        "Invoice number\n5CR0HBCL-0004\nDate of issue\nJune 6, 2026\nAmount due 100.00"
    ))
    assert f.value("invoice_number") == "5CR0HBCL-0004"
    assert f.value("invoice_date") == "June 6, 2026"
    assert f.value("total") == 100.0


def test_tax_rate_percentage_is_not_captured_as_amount():
    # "CGST 9% 900.00" must yield the amount 900, never the 9% rate.
    f = FieldExtractor().extract(_content("CGST 9% 900.00  SGST 9% 900.00  Grand Total 11800"))
    assert f.value("cgst") == 900.0
    assert f.value("sgst") == 900.0
    assert f.value("total") == 11800.0


def test_structured_json_mapping():
    f = FieldExtractor().extract(_content(structured=_INV01, dtype=DocumentType.JSON_EINVOICE))
    assert f.value("irn") == "a1b2c3"
    assert f.value("invoice_number") == "INV-2026-501"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("buyer_gstin") == "29AAGCR1234M1Z5"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"
    assert f.get("vendor_gstin").confidence >= 0.95   # structured = high confidence


def test_structured_from_wrapped_xml_shape():
    # XML extractor wraps as {"Invoice": {...}}; the deep search still finds sections.
    wrapped = {"Invoice": _INV01}
    f = FieldExtractor().extract(_content(structured=wrapped, dtype=DocumentType.XML_INVOICE))
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("total") == 11800.0


def test_text_regex_extraction():
    f = FieldExtractor().extract(_content(text=_TEXT))
    assert f.value("invoice_number") == "INV-2026-777"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"
    assert f.get("total").confidence < 0.9   # text = lower confidence than structured


def test_structured_beats_text_confidence():
    # both present: structured value wins (higher confidence, not overwritten by text)
    f = FieldExtractor().extract(
        _content(text="Invoice No: TEXT-1", structured=_INV01, dtype=DocumentType.JSON_EINVOICE)
    )
    assert f.value("invoice_number") == "INV-2026-501"


def test_non_inv01_xml_via_aliases():
    """A UBL/custom XML shape (not GST INV-01) still maps via tag aliases."""
    ubl = {"Invoice": {
        "InvoiceNumber": "INV-2026-777",
        "InvoiceDate": "2026-07-06",
        "SellerGSTIN": "27AABCU9603R1ZN",
        "TotalAmount": "11,800.00",
        "CGST": "900", "SGST": "900",
        "HSN": "998314",
    }}
    f = FieldExtractor().extract(_content(structured=ubl, dtype=DocumentType.XML_INVOICE))
    assert f.value("invoice_number") == "INV-2026-777"
    assert f.value("vendor_gstin") == "27AABCU9603R1ZN"
    assert f.value("total") == 11800.0
    assert f.value("cgst") == 900.0
    assert f.value("hsn_sac") == "998314"


# Real Anthropic (OIDAR) invoice text: the seller's GST reg is a non-standard "99…" that fails the
# standard GSTIN shape, so the only standard-shape GSTIN on the page is OUR OWN bill-to one.
_ANTHROPIC_OIDAR = (
    "Invoice\nInvoice number\n5CR0HBCL-0004\nDate of issue\nJune 6, 2026\nDate due\nJune 6, 2026\n"
    "VAT Registration India GST:\n9924USA29003OSI\n"
    "Anthropic, PBC\n548 Market Street\nSan Francisco, California 94104\nUnited States\n"
    "Bill to\nAyush Agarwal\nHSR Layout\nBangalore 560102\nTamil Nadu\nIndia\nmari@innovfix.in\n"
    "IN GST 29AAICI1603A1Z3\n"
    "$100.00 USD due June 6, 2026\n"
    "Total\n$100.00\nAmount due\n$100.00 USD\n"
    "[1] Tax to be paid on reverse charge basis\n"
)


def test_foreign_oidar_seller_recorded_as_vendor_not_our_own_gstin():
    # The seller (Anthropic OIDAR) reg fails the standard GSTIN shape, so a label-less grab would
    # take our OWN bill-to GSTIN as the vendor — a self-issued invoice. Ours must land in
    # buyer_gstin, and the vendor must be the seller's labelled "99…" non-resident registration:
    # that still fails validation (so the line still routes to review) but names the real reason —
    # an import of service under RCM, not an unknown supplier.
    f = FieldExtractor().extract(_content(text=_ANTHROPIC_OIDAR))
    assert f.value("buyer_gstin") == "29AAICI1603A1Z3"
    assert f.value("vendor_gstin") == "9924USA29003OSI"
    assert f.value("currency") == "USD"


def test_oidar_rescue_never_displaces_a_real_domestic_vendor():
    # A domestic seller plus a stray "99…" string elsewhere: the real vendor must win.
    f = FieldExtractor().extract(_content(
        "Tax Invoice\nSeller GSTIN: 27AABCU9603R1ZM\n"
        "VAT Registration India GST: 9924USA29003OSI\n"
        "Bill to\nInnovfix\nGSTIN 29AAGCR1234M1Z5\nGrand Total 11800\n"
    ))
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"


def test_unlabelled_99_string_is_not_taken_as_a_vendor():
    # The "99…" shape is only ever read under an explicit registration label.
    f = FieldExtractor().extract(_content("Order 9924USA29003OSI\nBill to\nGSTIN 29AAGCR1234M1Z5\n"))
    assert f.value("vendor_gstin") is None


# A paid RECEIPT (not an invoice): dates itself "Date paid", totals itself with a bare "Total",
# and prints no invoice date or "amount due" label anywhere.
_ANTHROPIC_RECEIPT = (
    "Page 1 of 1\nReceipt\nInvoice number\nGJAVSW60-0003\nReceipt number\n2943-7461-6436\n"
    "Date paid\nJune 18, 2026\n"
    "VAT Registration India GST:\n9924USA29003OSI\n"
    "Anthropic, PBC\n548 Market Street\nSan Francisco, California 94104\nUnited States\n"
    "support@anthropic.com\n"
    "Bill to\ndhanush\nHSR layout\nBangalore 560102\nKarnataka\nIndia\ndhanush@innovfix.in\n"
    "IN GST 29AAICI1603A1Z3\n"
    "$100.00 paid on June 18, 2026\n"
    "PAYMENT ADDRESS:\nAnthropic, PBC\nP.O. Box 104477\nPasadena, CA 91189-4477\n"
    "Description\nQty\nUnit price\nAmount\nMax plan - 5x\n1\n$100.00\n$100.00\n"
    "Subtotal\n$100.00\nTotal\n$100.00\nAmount paid\n$100.00\n"
)


def test_receipt_date_paid_and_bare_total():
    # Without "date paid" the line has no period to sit in; without the bare "Total" it has no value.
    f = FieldExtractor().extract(_content(text=_ANTHROPIC_RECEIPT))
    assert f.value("invoice_date") == "June 18, 2026"
    assert f.value("total") == 100.0
    assert f.value("vendor_gstin") == "9924USA29003OSI"


def test_subtotal_is_not_read_as_the_total():
    f = FieldExtractor().extract(_content("Subtotal\n$90.00\nTotal\n$100.00\n"))
    assert f.value("total") == 100.0


def test_bare_total_without_a_currency_symbol_is_not_a_total():
    # A "Total Qty" column header must never be read as the invoice total — the bare-total form
    # only fires on a number introduced by a currency symbol.
    f = FieldExtractor().extract(_content("Total Qty 5\nGrand Total 11800\n"))
    assert f.value("total") == 11800.0


def test_po_number_not_grabbed_from_inside_a_word_or_a_postal_box():
    # "support@…" once yielded po_number "rt"; a US supplier's "P.O. Box 104477" yielded "Box".
    f = FieldExtractor().extract(_content(text=_ANTHROPIC_RECEIPT))
    assert f.value("po_number") is None


def test_po_number_still_extracted_when_genuinely_present():
    for text, expected in (
        ("PO 12345\n", "12345"),
        ("P.O. No: ABC-778\n", "ABC-778"),
        ("Purchase Order #7788\n", "7788"),
    ):
        assert FieldExtractor().extract(_content(text)).value("po_number") == expected


def test_currency_iso_code_from_text():
    f = FieldExtractor().extract(_content(text="Max plan\nAmount due 49.00 USD"))
    assert f.value("currency") == "USD"


def test_currency_symbol_fallback_when_no_iso_code():
    # No ISO token anywhere — only a symbol attached to the amount.
    f = FieldExtractor().extract(_content(text="Total: $1,299.00"))
    assert f.value("currency") == "USD"


def test_distinct_seller_and_buyer_gstins_both_survive():
    # A normal B2B invoice with DIFFERENT seller/buyer GSTINs: the self-ref drop must not fire.
    f = FieldExtractor().extract(_content(
        "Tax Invoice\nSeller GSTIN: 27AABCU9603R1ZM\n"
        "Bill to\nInnovfix Private Limited\nGSTIN 29AAGCR1234M1Z5\n"
        "Grand Total 11800\n"
    ))
    assert f.value("vendor_gstin") == "27AABCU9603R1ZM"
    assert f.value("buyer_gstin") == "29AAGCR1234M1Z5"


def test_missing_fields_absent():
    f = FieldExtractor().extract(_content(text="no invoice data here"))
    assert f.value("total") is None
    assert f.value("vendor_gstin") is None
    assert f.value("buyer_gstin") is None
    assert f.value("currency") is None


def test_provenance_recorded():
    f = FieldExtractor().extract(_content(structured=_INV01, dtype=DocumentType.JSON_EINVOICE))
    assert f.get("vendor_gstin").source.startswith("structured:")
    d = f.to_dict()
    assert d["total"]["value"] == 11800.0 and "source" in d["total"]
