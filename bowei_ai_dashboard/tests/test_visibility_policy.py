import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.permissions import (
    can_access_confirmation_center,
    can_view_issue_decisions,
    can_view_issue_risks,
    can_view_settings,
    get_user_context,
)


def test_owner_sees_risks_and_confirmation_center_but_not_decisions():
    ctx = get_user_context("杨宇帆")
    assert can_view_issue_risks(ctx)
    assert can_access_confirmation_center(ctx)
    assert not can_view_issue_decisions(ctx)
    assert not can_view_settings(ctx)


def test_coordinator_sees_risks_and_confirmation_center_but_not_decisions():
    ctx = get_user_context("刘万超")
    assert can_view_issue_risks(ctx)
    assert can_access_confirmation_center(ctx)
    assert not can_view_issue_decisions(ctx)
    assert not can_view_settings(ctx)


def test_member_only_sees_progress():
    ctx = get_user_context("张三")
    assert not can_view_issue_risks(ctx)
    assert not can_access_confirmation_center(ctx)
    assert not can_view_issue_decisions(ctx)
    assert not can_view_settings(ctx)
