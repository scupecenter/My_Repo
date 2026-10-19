"""Build GSDN_Site_Master.xlsx from scratch (no data or formulas copied from old files).

Usage: python3 main.py <Rebuilt.xlsx> <old Site Master with Risk Register> <out.xlsx>
"""
import sys

import openpyxl

import calc_sheets
import master
import registers as R
import setting
import wh
from common import Names, register, title, font

ORDER = ["Guide", "Master", "Dashboard", "Project Status", "Progress & Plan", "RF & Design", "Acquisition",
         "PR-PO", "GECOL", "HLC", "As-Built", "WH", "WH Serials", "Risk Register", "Permits & HSE",
         "Data Quality", "Quality Inspections", "Change Control", "Readiness & Handover", "SLA", "Baseline",
         "Setting", "Site Calc"]


def reg_sheet(wb, names, sheet, tname, prefix, cols, freeze, nrows=10, data=None):
    ws = wb.create_sheet(sheet)
    register(ws, names, tname, prefix, cols, nrows=nrows, data=data, freeze=freeze)
    return ws


def risk_data(path):
    ws = openpyxl.load_workbook(path)["Risk Register"]
    rows = []
    for r in range(2, 202):
        rid = ws.cell(r, 1).value
        if not rid:
            continue
        v = [ws.cell(r, c).value for c in range(1, 19)]
        # old A..R: ID, Statement, Category, Scope, Affected, P, I, Score, Level, Response, Mitigation,
        # Risk Owner, Action Owner, Target, Status, Trend, Last Review, Next Review
        rows.append([v[0], v[1], v[2], v[3], v[4], v[5], v[6], None, None, v[9], v[10], v[11], None, v[13],
                     v[14], v[15], v[16], v[17]])
    return rows


def main(rebuilt, old, out):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    names = Names(wb)
    import sheets  # dashboard, project status, DQ, guide, progress & plan
    sheets.build_guide(wb, names)
    master.build(wb, names, rebuilt)
    sheets.build_dashboard(wb, names)
    sheets.build_project_status(wb, names)
    sheets.build_progress(wb, names)
    reg_sheet(wb, names, "RF & Design", "tblRF", "cRF", R.RF, "E3")
    names.add("SiteIDs", "tblRF[Site ID]")
    reg_sheet(wb, names, "Acquisition", "tblCandidates", "cAcq", R.ACQ, "F3")
    ws = wb.create_sheet("PR-PO")
    register(ws, names, "tblOrders", "cOrd", R.ORD, freeze="D3")
    register(ws, names, "tblContractors", "cCo", R.CO, first_col=len(R.ORD) + 2)
    register(ws, names, "tblTeams", "cTeam", R.TEAM, first_col=len(R.ORD) + len(R.CO) + 3)
    names.add("ContractorNames", "tblContractors[Contractor]")
    names.add("TeamNames", "tblTeams[Team]")
    reg_sheet(wb, names, "GECOL", "tblPower", "cPwr", R.PWR, "D3")
    reg_sheet(wb, names, "HLC", "tblFiber", "cFib", R.FIB, "D3")
    reg_sheet(wb, names, "As-Built", "tblAsBuilt", "cAB", R.AB, "D3")
    wh.build_wh(wb, names)
    wh.build_serials(wb, names)
    reg_sheet(wb, names, "Risk Register", "tblRiskRegister", "cRisk", R.RISK, "C3", nrows=30, data=risk_data(old))
    names.add("RiskIDs", "tblRiskRegister[Risk ID]")
    reg_sheet(wb, names, "Permits & HSE", "tblPermits", "cPrm", R.PRM, "D3")
    sheets.build_data_quality(wb, names)
    reg_sheet(wb, names, "Quality Inspections", "tblInspections", "cQI", R.QI, "E3")
    reg_sheet(wb, names, "Change Control", "tblChanges", "cChg", R.CHG, "D3")
    reg_sheet(wb, names, "Readiness & Handover", "tblReadiness", "cRdy", R.RDY, "D3")
    calc_sheets.build_sla(wb, names)
    calc_sheets.build_baseline(wb, names)
    setting.build(wb, names)
    calc_sheets.build_site_calc(wb, names, wh.ITEMS)
    sheets.finish(wb, names)
    wb._sheets = [wb[n] for n in ORDER]
    wb.active = 0
    wb.calculation.fullCalcOnLoad = True
    wb.save(out)


if __name__ == "__main__":
    main(*sys.argv[1:4])
