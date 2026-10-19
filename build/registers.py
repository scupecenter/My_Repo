"""Column definitions of the site registers (D45-D56, D61-D62, D70)."""
from common import Col, T, valid, wd

NAME = 'IF([[Site ID]]="","",IFERROR(INDEX(cRF_SiteName,MATCH([[Site ID]],cRF_SiteID,0))&"",""))'
REGION = 'IF([[Site ID]]="","",IFERROR(INDEX(cRF_Region,MATCH([[Site ID]],cRF_SiteID,0))&"",""))'


def num(first_data_row_offset=2):
    return Col("#", "num", T(f'=IF([[Site ID]]="","",ROW()-{first_data_row_offset})'), w=5)


def dist(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two coordinate pairs."""
    return (f"ROUND(6371000*ACOS(MIN(1,SIN(RADIANS({lat1}))*SIN(RADIANS({lat2}))"
            f"+COS(RADIANS({lat1}))*COS(RADIANS({lat2}))*COS(RADIANS({lon2})-RADIANS({lon1})))),0)")


D = ("date",)
W = ("whole",)


def dcol(name, **k):
    return Col(name, "in", dv=D, fmt="date", **k)


# ------------------------------------------------------------- RF & Design (D46)
RF = [
    num(),
    Col("Site ID", w=11),
    Col("Site Owner ID", w=13),
    Col("Site Name", w=18),
    Col("Region", dv="Region", w=13),
    Col("Sub Region", w=12),
    Col("Latitude", dv=("decimal", -90, 90), fmt="0.000000", w=11),
    Col("Longitude", dv=("decimal", -180, 180), fmt="0.000000", w=11),
    Col("Site Type", dv="SiteType", w=9),
    Col("Site Scenario", dv="Scenario", w=9),
    Col("Uplink Site", "calc", T('=IF([[MW Far-end Site]]="","",[[MW Far-end Site]]&"")'), w=11),
    Col("Tower Owner", dv="RefRFDesignTowerOwner", w=10),
    Col("Existing or New", dv="ExistNew", w=9),
    Col("RT or GF", dv="RTGF", w=7),
    Col("Tower Type", dv="TowerType", w=9),
    Col("Tower Height (m)", dv=("decimal", 0, 300), w=8),
    dcol("Nominal Plan Issue Date"),
    Col("Nominal Latitude", dv=("decimal", -90, 90), fmt="0.000000", w=11),
    Col("Nominal Longitude", dv=("decimal", -180, 180), fmt="0.000000", w=11),
    Col("Search Ring Radius (m)", dv=W, w=9),
    dcol("Search Ring Received Date"),
    Col("Deviation from Nominal (m)", "calc",
        T('=IF(OR(N([[Latitude]])=0,N([[Longitude]])=0,N([[Nominal Latitude]])=0,'
          'N([[Nominal Longitude]])=0),"",'
          + dist("[[Latitude]]", "[[Longitude]]", "[[Nominal Latitude]]", "[[Nominal Longitude]]")
          + ')'), fmt="int", w=10),
    Col("Cluster ID", w=10),
    Col("Antenna Height (m)", dv=("decimal", 0, 300), w=8),
    Col("Sectors", dv=W, w=7),
    Col("Azimuths", w=11),
    Col("M-Tilt / E-Tilt", w=9),
    dcol("RF Survey Actual Date"),
    Col("Approved Candidate", "calc",
        T('=IF([[Site ID]]="","",IFERROR(INDEX(cAcq_Candidate,MATCH([[Site ID]]&"|Yes",'
          'cAcq_SelectKeyhelper,0))&"",""))'), w=10),
    dcol("TSS Plan Date"),
    dcol("TSS Actual Date"),
    dcol("TSSR Submitted Date"),
    dcol("TSSR Approved Date"),
    Col("TSSR Status", dv="ReviewStatus", w=10),
    Col("TSSR Rev No.", dv=W, w=7),
    dcol("RF Data Sheet Issued"),
    dcol("MW LOS Survey Date"),
    Col("LOS Result", "calc",
        T('=IF([[Site ID]]="","",IFERROR(INDEX(cAcq_MWLOSCheck,MATCH([[Site ID]]&"|Yes",'
          'cAcq_SelectKeyhelper,0))&"",""))'), w=8),
    Col("MW Far-end Site", w=11),
    dcol("Link Budget Date"),
    dcol("Frequency License Date"),
    Col("Frequency License Ref", w=12),
    Col("Building Height (m)", dv=("decimal", 0, 300), w=8),
    Col("Cabinet Foundation (Existing / New)", dv="ExistNew", w=11),
    Col("Cabinet Foundation Dimensions (m)", w=11),
    Col("Backup Site", w=10),
    Col("Belong to FN", w=10),
    Col("Primary MFN", w=10),
    Col("Secondary MFN", w=10),
    Col("HLD Ref #", w=10),
    dcol("LLD Approved Date"),
    Col("Remark", w=24),
]

# ------------------------------------------------------------- Acquisition (D48, D35)
ACQ = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T('=IF([[Site ID]]="","",IFERROR(INDEX(cRF_SiteName,[[RF Row (helper)]])&"",""))'), w=16),
    Col("Region", "calc", T('=IF([[Site ID]]="","",IFERROR(INDEX(cRF_Region,[[RF Row (helper)]])&"",""))'), w=12),
    Col("Candidate", dv="Candidate", w=8),
    Col("Latitude", dv=("decimal", -90, 90), fmt="0.000000", w=11),
    Col("Longitude", dv=("decimal", -180, 180), fmt="0.000000", w=11),
    Col("Address", w=22),
    Col("Distance to Nominal (m)", "calc",
        T('=IF(OR(N([[Latitude]])=0,N([[Longitude]])=0),"",IFERROR(IF(OR(N(INDEX(cRF_NominalLatitude,'
          '[[RF Row (helper)]]))=0,N(INDEX(cRF_NominalLongitude,[[RF Row (helper)]]))=0),"",'
          + dist("[[Latitude]]", "[[Longitude]]", "INDEX(cRF_NominalLatitude,[[RF Row (helper)]])",
                 "INDEX(cRF_NominalLongitude,[[RF Row (helper)]])") + '),""))'), fmt="int", w=10),
    Col("Within Search Ring", "calc",
        T('=IF([[Distance to Nominal (m)]]="","",IF(N(INDEX(cRF_SearchRingRadiusm,[[RF Row (helper)]]))=0,"",'
          'IF([[Distance to Nominal (m)]]<=INDEX(cRF_SearchRingRadiusm,[[RF Row (helper)]]),"Yes","No")))'), w=9),
    dcol("Candidate Submitted Date (SAR)"),
    Col("MW LOS Check", dv="PassFail", w=8),
    Col("Test Pit Result", dv="TestPit", w=9),
    dcol("TSS Date"),
    Col("Selected", dv="YesNo", w=8),
    dcol("Selection Date"),
    Col("Owner / Landlord", w=16),
    Col("Ownership Type", dv="Ownership", w=12),
    Col("Contact Person", w=14),
    Col("Phone", w=12),
    Col("E-mail", w=16),
    dcol("Negotiation Start Date"),
    Col("Contract No.", w=12),
    dcol("Contract Sign-off Date"),
    dcol("Lease Expiry Date"),
    Col("Title Verified", dv="YesNo", w=8),
    dcol("Lease Termination Notice Date"),
    dcol("Site Handback Date (Restored)"),
    Col("Feeds Master", "calc",
        T('=IF([[Site ID]]="","",IF(AND([[Selected]]="Yes",COUNTIFS(cAcq_SiteID,[[Site ID]],'
          'cAcq_Selected,"Yes")=1),"Yes","No"))'), w=8),
    Col("Acquisition Completed Date", "calc",
        T('=IF(AND([[Feeds Master]]="Yes",' + valid("[[Contract Sign-off Date]]") + '),[[Contract Sign-off Date]],"")'),
        fmt="date"),
    Col("Acquisition Status", "calc",
        T('=IF([[Site ID]]="","",IF(COUNTIFS(cChg_SiteID,[[Site ID]],cChg_ChangeType,"Cancellation",'
          'cChg_Approval,"Approved")>0,"Cancelled",IF(AND(' + valid("[[Lease Termination Notice Date]]")
          + ',N(RptDate)>0,N([[Lease Termination Notice Date]])<=N(RptDate)),"Terminated",IF(AND('
          '[[Selected]]="Yes",' + valid("[[Contract Sign-off Date]]") + '),"Done",IF('
          + valid("[[Negotiation Start Date]]") + ',"In Negotiation","Pending")))))'), w=11),
    Col("Remark", w=20),
    Col("RF Row (helper)", "calc", T('=IF([[Site ID]]="","",IFERROR(MATCH([[Site ID]],cRF_SiteID,0),""))'), w=7),
    Col("Select Key (helper)", "calc", T('=IF([[Site ID]]="","",[[Site ID]]&"|"&[[Selected]])'), w=10),
]

# ------------------------------------------------------------- Permits & HSE (D49, D36)
CHK = ["JSA TRA", "Toolbox Talk", "Work at Height", "Lifting Plan", "LOTO", "Rescue Plan"]
PRM = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Type", dv="PAType", w=20),
    dcol("Applied / Requested"),
    Col("Status", dv="PAStatus", w=9),
    dcol("Valid From"),
    dcol("Valid To"),
    Col("Validity", "calc",
        T('=IF([[Site ID]]="","",IF([[Status]]="N/A",IF(AND([[N/A Reason]]<>"",[[N/A Approved By]]<>""),'
          '"N/A","N/A (incomplete)"),IF([[Status]]<>"Approved",IF([[Status]]="","Not set",[[Status]]),'
          'IF(NOT(' + valid("[[Valid From]]") + '),"Missing Valid From",IF(N([[Valid To]])=0,'
          'IF(IFERROR(INDEX(PATypeHasExpiry,MATCH([[Type]],PAType,0)),"")="No","Valid","No Expiry Date"),'
          'IF(N(RptDate)=0,"Valid",IF([[Valid To]]<RptDate,"Expired",IF([[Valid To]]-RptDate<=ExpiringDays,'
          '"Expiring","Valid"))))))))'), w=12),
    Col("N/A Reason", w=16),
    Col("N/A Approved By", dv="StaffNames", w=12),
    Col("Remark", w=18),
] + [Col(c, dv="EHSCheck", w=8) for c in CHK] + [
    Col("Stop Work", dv="YesNo", w=7),
    dcol("Stop Lifted Date"),
    Col("HSE Valid Date", "calc",
        T('=IF(LEFT([[Type]],3)<>"PTW","",IF(AND([[Status]]="Approved",' + valid("[[Valid From]]") + ','
          + ",".join(f'OR([[{c}]]="Done",[[{c}]]="N/A")' for c in CHK)
          + ',OR([[Stop Work]]<>"Yes",' + valid("[[Stop Lifted Date]]") + ')),MAX([[Valid From]],'
          'IF([[Stop Work]]="Yes",[[Stop Lifted Date]],0)),""))'), fmt="date"),
    Col("Stop End (helper)", "calc",
        T('=IF([[Stop Work]]="Yes",IF(' + valid("[[Stop Lifted Date]]") + ',[[Stop Lifted Date]],DateMax),"")'),
        fmt="date"),
]

# ------------------------------------------------------------- PR-PO (D26)
ORD = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Scope", dv="ProcScope", w=13),
    Col("Delivery", dv="Delivery", w=11),
    Col("PR No.", w=11),
    dcol("PR Date"),
    Col("PO / WO No.", w=11),
    dcol("PO / WO Date"),
    Col("Contractor", dv="ContractorNames", w=16),
    Col("Team", dv="TeamNames", w=14),
    Col("Order Status", dv="ProcStatus", w=10),
    Col("Remark", w=18),
    Col("PR→PO (wd)", "calc",
        T('=IF(AND(' + valid("[[PR Date]]") + ',' + valid("[[PO / WO Date]]") + '),'
          + wd("[[PR Date]]", "[[PO / WO Date]]") + ',"")'), fmt="int", w=8),
    Col("Check", "calc",
        T('=IF([[Site ID]]="","",IF(COUNTIF(Master_B,[[Site ID]])=0,"Site not in Master",IF([[Scope]]="",'
          '"Scope missing",IF([[Order Status]]="","Status missing",IF(AND([[Delivery]]="In-House",'
          'N([[PR Date]])>0),"In-House with PR",IF(AND([[Delivery]]="Outsourced",N([[PR Date]])=0,'
          'N([[PO / WO Date]])>0),"PO without PR",IF(AND(N([[PR Date]])>0,N([[PO / WO Date]])>0,'
          '[[PO / WO Date]]<[[PR Date]]),"PO before PR",IF(AND([[Contractor]]<>"",COUNTIF(cCo_Contractor,'
          '[[Contractor]])=0),"Unknown contractor",IF(AND([[Team]]<>"",COUNTIF(cTeam_Team,[[Team]])=0),'
          '"Unknown team",IF(AND([[Team]]<>"",IFERROR(INDEX(cTeam_Contractor,MATCH([[Team]],cTeam_Team,0))&"",'
          '"")<>[[Contractor]]&""),"Team of another contractor",IF(AND([[Team]]<>"",ISERROR(SEARCH(IFERROR('
          'INDEX(cTeam_Specialization,MATCH([[Team]],cTeam_Team,0))&"","#"),IFERROR(INDEX(ScopeMatchSpec,'
          'MATCH([[Scope]],ScopeMatchScope,0))&"",[[Scope]])))),"Team specialization","OK")))))))))))'), w=16),
]
CO = [
    Col("Contractor", w=18, nm="cCo_Contractor"),
    Col("Company Type", dv="CompanyType", w=12),
    Col("Contract Ref", w=12),
    dcol("Contract Start"),
    dcol("Contract End"),
    Col("Status", dv="CoStatus", w=9, nm="cCo_Status"),
    Col("Contract Validity", "calc",
        T('=IF([[Contractor]]="","",IF(NOT(' + valid("[[Contract Start]]") + '),"Missing start",'
          'IF(N([[Contract End]])=0,"Open-ended",IF([[Contract End]]<[[Contract Start]],"Date error",'
          'IF(N(RptDate)=0,"Valid",IF([[Contract End]]<RptDate,"Expired",IF([[Contract End]]-RptDate'
          '<=ExpiringDays,"Expiring","Valid")))))))'), w=10),
    Col("Assigned Sites", "calc",
        T('=IF([[Contractor]]="","",COUNTIFS(cOrd_Contractor,[[Contractor]],cOrd_OrderStatus,"<>Cancelled"))'),
        fmt="int", w=8),
]
TEAM = [
    Col("Team", w=16, nm="cTeam_Team"),
    Col("Team Type", dv="TeamType", w=10),
    Col("Contractor", dv="ContractorNames", w=16, nm="cTeam_Contractor"),
    Col("Specialization", dv="TeamSpecialization", w=10, nm="cTeam_Specialization"),
    Col("Status", dv="TeamStatus", w=8, nm="cTeam_Status"),
]

# ------------------------------------------------------------- GECOL (D50) / HLC (D52)
ORDER_FIRST = ('IFERROR(INDEX(cOrd_{f},MATCH(1,INDEX((cOrd_SiteID=[[Site ID]])*(cOrd_Scope="GECOL")'
               '*(cOrd_OrderStatus<>"Cancelled"),0),0))&"","")')
PWR = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Region", "calc", T("=" + REGION), w=12),
    Col("GECOL PR No.", "calc", T('=IF([[Site ID]]="","",' + ORDER_FIRST.format(f="PRNo") + ')'), w=11),
    Col("GECOL Contractor", "calc", T('=IF([[Site ID]]="","",' + ORDER_FIRST.format(f="Contractor") + ')'), w=14),
    dcol("Survey Date"),
    dcol("Layout Received"),
    dcol("Layout Approved"),
    dcol("GECOL Notice Date"),
    dcol("MOS Date"),
    dcol("Installation Finish Date"),
    dcol("AAT Acceptance Date"),
    dcol("GECOL Docs Approval Date"),
    Col("Meter No.", w=11),
    dcol("Power-On Date (Meter Charging)"),
    dcol("Billing Conversion Date"),
    Col("Status", "calc",
        T('=IF([[Site ID]]="","",IF(IFERROR(INDEX(Master_AC,MATCH([[Site ID]],Master_B,0))&"","")="N/A",'
          '"N/A",IF(AND(IFERROR(INDEX(Master_AC,MATCH([[Site ID]],Master_B,0))&"","")="Yes",'
          'COUNTIF(cPwr_SiteID,[[Site ID]])=1,' + valid("[[Power-On Date (Meter Charging)]]")
          + '),"Done","Pending")))'), w=9),
    Col("Remark", w=18),
]
FIB = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Region", "calc", T("=" + REGION), w=12),
    Col("HLC Request No.", w=11),
    dcol("Request Date"),
    Col("Fiber Uplink (Exchange / Post)", w=16),
    Col("Fiber Status", dv="FiberStatus", w=12),
    Col("Internal Fiber Team", dv="TeamNames", w=12),
    dcol("Installation Date"),
    dcol("TX Link Tested Date"),
    Col("Status", "calc",
        T('=IF([[Site ID]]="","",IF(IFERROR(INDEX(Master_AD,MATCH([[Site ID]],Master_B,0))&"","")="N/A",'
          '"N/A",IF(AND(IFERROR(INDEX(Master_AD,MATCH([[Site ID]],Master_B,0))&"","")="Yes",'
          'COUNTIF(cFib_SiteID,[[Site ID]])=1,' + valid("[[Installation Date]]") + '),"Done","Pending")))'), w=9),
    Col("Remark", w=18),
]

# ------------------------------------------------------------- As-Built (D56)
_AB_IN = ["Tower (m)", "Mounting Pole (m)", "Concrete Plain (m3)", "Concrete Reinforcement (m3)",
          "AC Cable 4x16 (m)", "AC Cable 4x10 (m)", "DC Cable 25 (m)", "DC Cable 35 (m)",
          "Patch Cord Fiber (m)", "Outdoor Shield Fiber (m)", "Indoor Cable Tray (m)",
          "Outdoor Cable Tray (m)", 'PVC 1" (m)', 'PVC 1.5" (m)', 'PVC 2" (m)', "GND 16 (m)",
          "GND 35 (m)", "GND 50 (m)", "Busbar (pcs)", "Copper Rod (pcs)", "Copper-plated Rod (pcs)",
          "Manhole (pcs)", "63A 3P AC (pcs)", "63A 1P DC (pcs)", "32A 1P DC (pcs)", "16A 1P DC (pcs)",
          "10A 1P DC (pcs)", "AC Box (pcs)", "DC Box (pcs)", "AC Box Stand (pcs)", "Indoor Rack (pcs)"]
AB = [num(), Col("Site ID", dv="SiteIDs", w=11), Col("Site Name", "calc", T("=" + NAME), w=16)]
AB += [Col(c, dv=("decimal", 0, 100000), w=8) for c in _AB_IN]
AB += [
    Col("Configuration (WL/MW/IP/PWR)", w=14),
    Col("WL Vendor", dv="WLVendor", w=10),
    Col("Sector Qty", dv=W, w=7),
    Col("WL Antenna Type", dv="WHItemNames", w=14),
    Col("RF Height (m)", dv=("decimal", 0, 300), w=7),
    Col("Azimuth", w=10),
    Col("M-Tilt", w=7),
    Col("MW Vendor", w=10),
    Col("MW Antenna Qty", dv=W, w=7),
    Col("MW Antenna Type", dv="WHItemNames", w=14),
    Col("MW Antenna Height (m)", dv=("decimal", 0, 300), w=7),
    Col("MW Azimuth", w=8),
    Col("RSL", dv=("decimal", -200, 0), w=7),
    Col("MW Uplink Site", "calc",
        T('=IF([[Site ID]]="","",IFERROR(INDEX(cRF_UplinkSite,MATCH([[Site ID]],cRF_SiteID,0))&"",""))'), w=10),
    Col("IP Vendor", w=10),
    Col("Router Qty", dv=W, w=7),
    Col("Router Type", dv="WHItemNames", w=14),
    Col("Rectifier Status", w=10),
    Col("Power Vendor", w=10),
    Col("Rated Rectifier (kW)", dv=("decimal", 0, 1000), w=8),
    Col("No. Charger (Existing)", dv=W, w=7),
    Col("Max Charger (W)", dv=("decimal", 0, 100000), w=8),
    Col("MDB Type", w=9),
    Col("Battery Type", w=10),
    Col("Battery Model", w=12),
    Col("Battery Capacity (AH)", dv=("decimal", 0, 100000), w=8),
    Col("Battery Qty", dv=W, w=7),
    Col("Backup Time (h)", dv=("decimal", 0, 1000), w=7),
    Col("D.G", w=7),
    Col("Patch Cord 1", dv="WHItemNames", w=14),
    Col("Patch Cord 1 Qty", dv=W, w=7),
    Col("Patch Cord 2", dv="WHItemNames", w=14),
    Col("Patch Cord 2 Qty", dv=W, w=7),
]

# ------------------------------------------------------------- Quality Inspections (D54)
QI = [
    num(),
    Col("Record ID", w=10),
    Col("Record Type", dv="RefQualityInspectionsRecordType", w=8),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Stage", dv="QCStage", w=9),
    Col("Activity", dv="QCActivity", w=18),
    Col("Point Type", dv="RefQualityInspectionsPointType", w=8),
    Col("Description", w=24),
    Col("Severity", dv="Severity", w=8),
    Col("Team", dv="TeamNames", w=14),
    Col("Contractor", "calc",
        T('=IF([[Team]]="","",IFERROR(INDEX(cTeam_Contractor,MATCH([[Team]],cTeam_Team,0))&"",""))'), w=14),
    dcol("Raised / Submitted Date"),
    dcol("Target Date"),
    Col("Result", dv="RefQualityInspectionsResult", w=9),
    dcol("Closed / Released Date"),
    Col("Approved / Released By", dv="StaffNames", w=12),
    Col("Root Cause & Corrective Action", w=22),
    Col("Linked Record ID", w=10),
    Col("N/A Reason", w=14),
    Col("N/A Approved By", dv="StaffNames", w=12),
    Col("Status", "calc",
        T('=IF([[Site ID]]="","",IF([[Result]]="N/A",IF(AND([[N/A Reason]]<>"",[[N/A Approved By]]<>""),'
          '"N/A","N/A (incomplete)"),IF(AND(' + valid("[[Closed / Released Date]]") + ',OR([[Result]]='
          '"Approved",[[Result]]="Cleared",[[Result]]="Pass")),"Closed",IF(AND(N(RptDate)>0,'
          + valid("[[Target Date]]") + ',[[Target Date]]<RptDate),"Overdue","Open"))))'), w=9),
    Col("Blocking", "calc",
        T('=IF([[Site ID]]="","",IF(OR([[Status]]="Closed",[[Status]]="N/A"),"No",IF(OR(AND([[Record Type]]'
          '="ITP",[[Point Type]]="Hold"),[[Record Type]]="NCR",AND([[Record Type]]="Snag",OR([[Severity]]'
          '="Critical",[[Severity]]="Major",[[Severity]]=""))),"Yes","No")))'), w=8),
    Col("Remark", w=18),
]

# ------------------------------------------------------------- Change Control (D53)
CHG = [
    num(),
    Col("Change ID", w=10),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Change Type", dv="ChangeType", w=13),
    Col("Change Scope", dv="ChangeScope", w=8),
    Col("Field / Scope Item", w=14),
    Col("Old Value", w=12),
    Col("New Value", w=12),
    Col("Reason / Remark", w=24),
    dcol("Request Date"),
    Col("Approval", dv="ApprStatus", w=9),
    Col("Approved By", dv="StaffNames", w=12),
    dcol("Approval Date"),
    Col("Change Ticket ID", w=11),
]


def mlook(col, key="[[Site ID]]"):
    return f"INDEX(Master_{col},MATCH({key},Master_B,0))"


# ------------------------------------------------------------- Readiness & Handover (D55)
RDY = [
    num(),
    Col("Site ID", dv="SiteIDs", w=11),
    Col("Site Name", "calc", T("=" + NAME), w=16),
    Col("Open Controls", "calc", None, w=28),          # formula set below (needs other columns)
    dcol("Commissioning Power Safe Date"),
    dcol("Uplink Ready Date"),
    Col("O&M Checklist", dv="EHSCheck", w=9),
    Col("N/A Reason", w=14),
    Col("N/A Approved By", dv="StaffNames", w=12),
    Col("O&M Accepted By", w=12),
    dcol("O&M Acceptance Date"),
    Col("Ops Acceptance Valid Date", "calc",
        T('=IF(AND(OR([[O&M Checklist]]="Done",AND([[O&M Checklist]]="N/A",[[N/A Reason]]<>"",'
          '[[N/A Approved By]]<>"")),[[O&M Accepted By]]<>"",' + valid("[[O&M Acceptance Date]]")
          + '),[[O&M Acceptance Date]],"")'), fmt="date"),
    dcol("Site Access & Keys Handover Date"),
    dcol("HOTO Package Actual Date"),
    Col("HOTO Package Valid Date", "calc",
        T('=IF(AND(' + valid("[[HOTO Package Actual Date]]") + ',' + valid("[[Site Access & Keys Handover Date]]")
          + '),MAX([[HOTO Package Actual Date]],[[Site Access & Keys Handover Date]]),"")'), fmt="date"),
    dcol("Legacy Handover Date"),
    dcol("Obligations Closure Date"),
    Col("Closure Approved By", dv="StaffNames", w=12),
    dcol("Closure Approval Date"),
    Col("Closure Ready", "calc", None, w=9),
    Col("Final Closure", "calc",
        T('=IF(AND([[Closure Ready]]="Yes",' + valid("[[Closure Approval Date]]") + '),[[Closure Approval Date]],"")'),
        fmt="date"),
    Col("Control Status", "calc",
        T('=IF([[Site ID]]="","",IF([[Open Controls]]="","Complete","Open"))'), w=9),
]

_CW = "IFERROR(INDEX(SC_CW,MATCH([[Site ID]],SC_Site,0))&\"\",\"\")"
_TE = "IFERROR(INDEX(SC_TE,MATCH([[Site ID]],SC_Site,0))&\"\",\"\")"
_SNAG = ('OR(AND({f}="Yes",{c}="Yes"),AND({f}="N/A",{c}="N/A"),AND({f}="No",{c}=""))')


def _snag(fc, cc):
    f, c = mlook(fc) + '&""', mlook(cc) + '&""'
    return _SNAG.format(f=f, c=c)


_CLOSE = ('AND(OR(' + _CW + '<>"Yes",AND(' + valid(mlook("FE")) + ',' + _snag("FC", "FD") + ')),'
          'OR(' + _TE + '<>"Yes",AND(' + valid(mlook("FJ")) + ',' + _snag("FH", "FI") + ')),'
          + valid("[[Obligations Closure Date]]") + ',COUNTIFS(cQI_SiteID,[[Site ID]],cQI_Blocking,"Yes")=0,'
          '[[Closure Approved By]]<>"",' + valid("[[Closure Approval Date]]") + ')')
for c in RDY:
    if c.name == "Closure Ready":
        c.f = T('=IF([[Site ID]]="","",IFERROR(IF(' + _CLOSE + ',"Yes","No"),"No"))')
    if c.name == "Open Controls":
        swap = 'OR(' + mlook("Z") + '="Hot Swap",' + mlook("Z") + '="Cold Swap")'
        parts = [
            ('IF(' + valid("[[Commissioning Power Safe Date]]") + ',"","Power Safe")'),
            ('IF(OR(' + mlook("L") + '&""="",' + mlook("L") + '&""="N/A",' + valid("[[Uplink Ready Date]]")
             + '),"","Uplink")'),
            ('IF(COUNTIFS(cQI_SiteID,[[Site ID]],cQI_RecordType,"ITP",cQI_Blocking,"Yes")=0,"","ITP Hold")'),
            ('IF(NOT(' + swap + '),"",IF(COUNTIFS(cChg_SiteID,[[Site ID]],cChg_ChangeType,"Cutover Window",'
             'cChg_Approval,"Approved")>0,"","Cutover Window"))'),
            ('IF([[Ops Acceptance Valid Date]]<>"","","O&M Acceptance")'),
            ('IF([[HOTO Package Valid Date]]<>"","","HOTO Package")'),
            ('IF(NOT(' + swap + '),"",IF(' + valid("[[Legacy Handover Date]]") + ',"","Legacy Handover"))'),
            ('IF([[Closure Ready]]="Yes","","Closure")'),
        ]
        c.f = T('=IF([[Site ID]]="","",IFERROR(_xlfn.TEXTJOIN(", ",TRUE,' + ",".join(parts) + '),""))')

# ------------------------------------------------------------- Risk Register (D70)
RISK = [
    Col("Risk ID", w=8),
    Col("Risk Statement", w=60),
    Col("Category", dv="RiskCat", w=14),
    Col("Scope", dv="ScopeCWTE", w=7),
    Col("Affected Sites", dv=W, w=7),
    Col("Probability (1-5)", dv=("decimal", 1, 5), w=8),
    Col("Impact (1-5)", dv=("decimal", 1, 5), w=7),
    Col("Risk Score", "calc",
        T('=IF(OR([[Probability (1-5)]]="",[[Impact (1-5)]]=""),"",[[Probability (1-5)]]*[[Impact (1-5)]])'),
        fmt="int", w=7),
    Col("Risk Level", "calc",
        T('=IF([[Risk Score]]="","",IF([[Risk Score]]>=RiskCritical,"Critical",IF([[Risk Score]]>=RiskHigh,'
          '"High",IF([[Risk Score]]>=RiskMedium,"Medium","Low"))))'), w=8),
    Col("Response", dv="RiskResponse", w=9),
    Col("Mitigation Action", w=40),
    Col("Risk Owner", w=16),
    Col("Action Owner", dv="StaffNames", w=12),
    dcol("Target Date"),
    Col("Status", dv="RiskStatus", w=9),
    Col("Trend", dv="Trend", w=9),
    dcol("Last Review Date"),
    dcol("Next Review Date"),
]
