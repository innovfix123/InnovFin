"""Trusted-source hints from the Drive archive's folder names and filenames.

Every literal below mirrors the exact SHAPE of a real folder or filename from the finance
purchase-invoice archive — apostrophe-years ("Apr'26"), underscore decimals ("INR10867_72"),
internal hyphens, leading digits, the word "Invoice" both standalone and glued into a name. Vendor
and person names are aliased, because this repository is public and the real ones, paired with the
amounts, are confidential. Shapes are what the parser must survive; identities are not.
"""

from fields.drive_hints import (
    DriveHintEnricher,
    amount_from_filename,
    vendor_from_drive_path,
)
from fields.models import InvoiceFields

BASE = "/2026-27/4. Purchases & Expenses Invoices/1. Purchase Invoices- Apr'26"


def _path(folder: str, name: str = "doc.pdf") -> str:
    return f"{BASE}/{folder}/{name}"


class TestVendorFromPath:
    def test_strips_trailing_month_and_the_word_invoice(self):
        assert vendor_from_drive_path(_path("VendorOne Invoice_Apr'26")) == "VendorOne"
        assert vendor_from_drive_path(_path("VendorTwo Invoice_Apr'26")) == "VendorTwo"

    def test_keeps_multi_word_vendor_names(self):
        assert vendor_from_drive_path(_path("Cloud Host Apr'26")) == "Cloud Host"
        assert vendor_from_drive_path(_path("Audio Labs_Apr'26")) == "Audio Labs"
        assert vendor_from_drive_path(_path("Office Rent Apr 2026")) == "Office Rent"

    def test_keeps_internal_hyphenated_names(self):
        # Stripping runs from the END only, so a real hyphen inside the name survives.
        assert vendor_from_drive_path(_path("Courier - Printing - Apr'26")) == "Courier - Printing"
        assert vendor_from_drive_path(_path("AppTwo - Gateway - April 2026")) == "AppTwo - Gateway"
        assert vendor_from_drive_path(_path("AI Tool - USA - Apr'26")) == "AI Tool - USA"

    def test_leading_digits_are_not_mistaken_for_a_date(self):
        assert vendor_from_drive_path(_path("11Audio - April 2026")) == "11Audio"

    def test_folder_with_no_date_is_returned_as_is(self):
        assert vendor_from_drive_path(_path("ClientApp")) == "ClientApp"

    def test_the_word_invoices_glued_into_a_name_is_kept(self):
        # "ACInvoices" is a vendor abbreviation, not the noise word "Invoices".
        assert vendor_from_drive_path(_path("ACInvoices")) == "ACInvoices"

    def test_date_only_folder_names_no_vendor(self):
        assert vendor_from_drive_path(_path("Invoices-2026-05-07")) is None

    def test_missing_or_shallow_paths(self):
        assert vendor_from_drive_path("") is None
        assert vendor_from_drive_path("just-a-file.pdf") is None


class TestAmountFromFilename:
    def test_currency_before_and_after_the_number(self):
        assert amount_from_filename("VendorTwo - 01 Apr 2026 - USD 16097.60.pdf") == 16097.60
        assert amount_from_filename("AdNetwork_7th Apr'26_116.73 INR.pdf") == 116.73
        assert amount_from_filename("PRO_HOUSING_PG-INR1500-20260101-181.jpeg") == 1500
        assert amount_from_filename("CloudHost 03-Apr-2026-151694092-USD264.64.pdf") == 264.64
        assert amount_from_filename("ClientApp - AdNetwork - 2026-05-01 - Rs. 5,206.23.pdf") == 5206.23

    def test_currency_prefixed_reading_wins_over_a_preceding_year(self):
        # The suffix reading would match "2026 USD" first and silently return 2026 as the total.
        assert amount_from_filename(
            "Employee - VendorOne - AI Tool Invoice-LOBVVT6Z-0001 - 23-04-2026 USD 100.pdf"
        ) == 100

    def test_underscore_is_read_as_a_decimal_point(self):
        assert amount_from_filename(
            "Comms_Vendor_Limited-INR10867_72-20260427-SBIE.pdf"
        ) == 10867.72

    def test_a_trailing_date_is_not_read_as_a_decimal(self):
        # "INR40000_20260403" is forty thousand, not 40000.20.
        assert amount_from_filename("Contractor_Name-INR40000_20260403-12.pdf") == 40000

    def test_a_bare_number_without_a_currency_is_ignored(self):
        assert amount_from_filename("Courier_ORD90595943624_8th Apr'26.pdf") is None
        assert amount_from_filename("Gateway ClientApp - 30 Apr 2026.pdf") is None
        assert amount_from_filename("") is None


class _Meta:
    def __init__(self, source_ref="", filename=""):
        self.source_ref = source_ref
        self.filename = filename


class TestEnricher:
    def test_fills_empty_fields(self):
        f = InvoiceFields()
        DriveHintEnricher().enrich(
            f, _Meta(_path("Editor - Apr'26", "x.pdf"), "Editor - USD 20.00.pdf"))
        assert f.value("vendor_name") == "Editor"
        assert f.value("total") == 20.00

    def test_never_overrides_an_extracted_value(self):
        """A hint is a fallback. Text extraction (0.6) and structured (0.9) both outrank it."""
        f = InvoiceFields()
        f.set("total", 999.0, 0.6, "text:total")
        f.set("vendor_name", "Editor Inc.", 0.9, "structured:SellerDtls")
        DriveHintEnricher().enrich(
            f, _Meta(_path("Editor - Apr'26", "x.pdf"), "Editor - USD 20.00.pdf"))
        assert f.value("total") == 999.0
        assert f.value("vendor_name") == "Editor Inc."

    def test_records_provenance_so_a_hinted_figure_is_auditable(self):
        f = InvoiceFields()
        DriveHintEnricher().enrich(
            f, _Meta(_path("Editor - Apr'26", "x.pdf"), "Editor - USD 20.00.pdf"))
        assert f.get("vendor_name").source == "drive:folder"
        assert f.get("total").source == "drive:filename"

    def test_no_drive_path_is_harmless(self):
        f = InvoiceFields()
        DriveHintEnricher().enrich(f, _Meta("", ""))
        assert f.value("vendor_name") is None
        assert f.value("total") is None
