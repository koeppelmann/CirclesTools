// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title CirclesHelperV2
/// @notice On-chain helper for the Circles profile checker. Reads V1/V2 user data
///         and walks the V2 trust linked list with pagination (no 250-entry cap).
///         Supports group-aware balance queries: for groups, balances are held by
///         the treasury, not the group itself. The "For" function variants accept
///         a separate balanceHolder address for this purpose.
/// @dev Deployed on Gnosis Chain. Verified on Blockscout.
///      Key fix: trustMarkers(user, marker) returns (prev, expiry) where expiry
///      belongs to `marker`, not `prev`. We do an extra lookup to get prev's expiry.

interface IV1Token {
    function totalSupply() external view returns (uint256);
    function stopped() external view returns (bool);
    function lastTouched() external view returns (uint256);
}

interface IV1Hub {
    function userToToken(address) external view returns (address);
    function organizations(address) external view returns (bool);
}

interface IV2Hub {
    function isHuman(address) external view returns (bool);
    function isOrganization(address) external view returns (bool);
    function isGroup(address) external view returns (bool);
    function toTokenId(address) external view returns (uint256);
    function totalSupply(uint256) external view returns (uint256);
    function stopped(address) external view returns (bool);
    function calculateIssuance(address user) external view returns (uint256, uint256, uint256);
    function trustMarkers(address user, address marker) external view returns (address previous, uint96 expiry);
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

contract CirclesHelperV2 {
    IV1Hub public constant v1Hub = IV1Hub(0x29b9a7fBb8995b2423a71cC17cf9810798F6C543);
    IV2Hub public constant v2Hub = IV2Hub(0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8);

    address constant SENTINEL = 0x0000000000000000000000000000000000000001;

    struct V1Data {
        bool isOrg;
        bool isHuman;
        uint256 totalSupply;
        bool stopped;
        uint256 lastTouched;
    }

    struct V2Data {
        bool isHuman;
        bool isOrg;
        bool isGroup;
        uint256 crcAmount;
        uint256 ts1;
        uint256 ts2;
        uint256 totalSupply;
    }

    struct TrustedAddressData {
        address trustedAddress;
        uint256 expiry;
        bool v1Org;
        bool v1Human;
        bool v2Human;
        bool v2Org;
        bool v2Group;
        uint256 v2TotalSupply;
        uint256 userHolds;
    }

    // Pagination result for trust connections
    struct TrustPage {
        TrustedAddressData[] entries;
        address nextMarker;  // Pass this as startMarker for next page. address(0) means no more.
    }

    function getV1Data(address user) internal view returns (V1Data memory) {
        address tokenAddr = v1Hub.userToToken(user);
        bool isOrgV1 = v1Hub.organizations(user);
        bool isHumanV1 = (tokenAddr != address(0));

        uint256 v1TS = 0;
        bool v1Stopped = false;
        uint256 v1LastTouched = 0;
        if (isHumanV1) {
            IV1Token token = IV1Token(tokenAddr);
            v1TS = token.totalSupply();
            v1Stopped = token.stopped();
            v1LastTouched = token.lastTouched();
        }

        return V1Data(isOrgV1, isHumanV1, v1TS, v1Stopped, v1LastTouched);
    }

    function getV2Data(address user) internal view returns (V2Data memory) {
        bool v2IsHuman;
        bool v2IsOrg;
        bool v2IsGroup;
        try v2Hub.isHuman(user) returns (bool _isHuman) { v2IsHuman = _isHuman; } catch { v2IsHuman = false; }
        try v2Hub.isOrganization(user) returns (bool _isOrg) { v2IsOrg = _isOrg; } catch { v2IsOrg = false; }
        try v2Hub.isGroup(user) returns (bool _isGroup) { v2IsGroup = _isGroup; } catch { v2IsGroup = false; }

        uint256 crcAmount = 0;
        uint256 ts1 = 0;
        uint256 ts2 = 0;
        uint256 v2UserTotalSupply = 0;

        if (v2IsHuman || v2IsGroup) {
            try v2Hub.calculateIssuance(user) returns (uint256 _crc, uint256 _ts1, uint256 _ts2) {
                crcAmount = _crc; ts1 = _ts1; ts2 = _ts2;
            } catch {}

            try v2Hub.toTokenId(user) returns (uint256 tokenId) {
                if (tokenId != 0) {
                    try v2Hub.totalSupply(tokenId) returns (uint256 supply) {
                        v2UserTotalSupply = supply;
                    } catch {}
                }
            } catch {}
        }

        return V2Data(v2IsHuman, v2IsOrg, v2IsGroup, crcAmount, ts1, ts2, v2UserTotalSupply);
    }

    function getSingleTrustedData(address user, address balanceHolder, address marker) internal view returns (bool valid, TrustedAddressData memory data) {
        if (marker == SENTINEL || marker == address(0)) {
            return (false, data);
        }

        address tokenAddr = v1Hub.userToToken(marker);
        bool isHumanV1 = (tokenAddr != address(0));
        bool isOrgV1 = v1Hub.organizations(marker);

        bool isV2Human = false;
        bool isV2Org = false;
        bool isV2Group = false;
        try v2Hub.isHuman(marker) returns (bool _isHuman) { isV2Human = _isHuman; } catch {}
        try v2Hub.isOrganization(marker) returns (bool _isOrg) { isV2Org = _isOrg; } catch {}
        try v2Hub.isGroup(marker) returns (bool _isGroup) { isV2Group = _isGroup; } catch {}

        uint256 v2TS = 0;
        uint256 tokenIdForBalance = 0;
        try v2Hub.toTokenId(marker) returns (uint256 tokenId) {
            tokenIdForBalance = tokenId;
            if ((isV2Human || isV2Group) && tokenId != 0) {
                try v2Hub.totalSupply(tokenId) returns (uint256 supply) { v2TS = supply; } catch {}
            }
        } catch {}

        uint256 userBalance = 0;
        if (tokenIdForBalance != 0) {
            try v2Hub.balanceOf(balanceHolder, tokenIdForBalance) returns (uint256 balance) { userBalance = balance; } catch {}
        }

        data = TrustedAddressData({
            trustedAddress: marker,
            expiry: 0,
            v1Org: isOrgV1,
            v1Human: isHumanV1,
            v2Human: isV2Human,
            v2Org: isV2Org,
            v2Group: isV2Group,
            v2TotalSupply: v2TS,
            userHolds: userBalance
        });
        return (true, data);
    }

    /// @notice Get a page of trusted addresses with pagination
    /// @param user The user whose trust connections to fetch
    /// @param startMarker Where to start iterating. Use SENTINEL (0x01) for the first page.
    /// @param pageSize Max entries to return per page (e.g. 200)
    /// @return page The page of results with a nextMarker for continuation
    function getTrustedAddressesPage(
        address user,
        address startMarker,
        uint256 pageSize
    ) public view returns (TrustPage memory page) {
        return getTrustedAddressesPageFor(user, user, startMarker, pageSize);
    }

    function getTrustedAddressesPageFor(
        address user,
        address balanceHolder,
        address startMarker,
        uint256 pageSize
    ) public view returns (TrustPage memory page) {
        if (pageSize == 0) pageSize = 200;
        if (pageSize > 500) pageSize = 500;

        address currentMarker = startMarker;
        TrustedAddressData[] memory tempList = new TrustedAddressData[](pageSize);
        uint256 count = 0;

        while (count < pageSize) {
            address prev;
            uint96 expiry;
            try v2Hub.trustMarkers(user, currentMarker) returns (address _prev, uint96 _expiry) {
                prev = _prev;
                expiry = _expiry;
            } catch {
                break;
            }

            if (prev == address(0) || prev == SENTINEL) {
                // End of the linked list
                currentMarker = address(0);
                break;
            }

            // Get the actual expiry for `prev` by looking up its own trust marker
            uint96 prevExpiry;
            try v2Hub.trustMarkers(user, prev) returns (address, uint96 _prevExpiry) {
                prevExpiry = _prevExpiry;
            } catch {
                prevExpiry = expiry; // fallback
            }

            (bool valid, TrustedAddressData memory tData) = getSingleTrustedData(user, balanceHolder, prev);
            if (valid) {
                tData.expiry = uint256(prevExpiry);
                tempList[count] = tData;
                count++;
            }
            currentMarker = prev;
        }

        // Trim to actual count
        TrustedAddressData[] memory trimmed = new TrustedAddressData[](count);
        for (uint256 i = 0; i < count; i++) {
            trimmed[i] = tempList[i];
        }

        // If we filled the page, there might be more - return current marker for next call.
        // If we broke out early (sentinel/zero), nextMarker is address(0) meaning done.
        page.entries = trimmed;
        page.nextMarker = (count == pageSize) ? currentMarker : address(0);
    }

    /// @notice Original function signature preserved for backwards compatibility.
    ///         Now fetches ALL trust connections (no 250 limit) by iterating pages internally.
    function getAllDataForUser(address user) external view returns (
        V1Data memory v1Data,
        V2Data memory v2Data,
        TrustedAddressData[] memory trustedAddresses
    ) {
        v1Data = getV1Data(user);
        v2Data = getV2Data(user);

        // Iterate all pages to get ALL trust connections
        TrustedAddressData[] memory allTrusted = new TrustedAddressData[](0);
        address marker = SENTINEL;

        while (marker != address(0)) {
            TrustPage memory page = getTrustedAddressesPage(user, marker, 200);

            // Append page entries to allTrusted
            if (page.entries.length > 0) {
                TrustedAddressData[] memory combined = new TrustedAddressData[](allTrusted.length + page.entries.length);
                for (uint256 i = 0; i < allTrusted.length; i++) {
                    combined[i] = allTrusted[i];
                }
                for (uint256 i = 0; i < page.entries.length; i++) {
                    combined[allTrusted.length + i] = page.entries[i];
                }
                allTrusted = combined;
            }

            marker = page.nextMarker;
        }

        trustedAddresses = allTrusted;
    }

    /// @notice Get user data + first page of trust connections (for frontend pagination)
    function getUserDataWithTrustPage(
        address user,
        address startMarker,
        uint256 pageSize
    ) external view returns (
        V1Data memory v1Data,
        V2Data memory v2Data,
        TrustPage memory trustPage
    ) {
        v1Data = getV1Data(user);
        v2Data = getV2Data(user);
        trustPage = getTrustedAddressesPage(user, startMarker, pageSize);
    }

    /// @notice Group-aware version: balances are read from balanceHolder (e.g. treasury) instead of user
    function getUserDataWithTrustPageFor(
        address user,
        address balanceHolder,
        address startMarker,
        uint256 pageSize
    ) external view returns (
        V1Data memory v1Data,
        V2Data memory v2Data,
        TrustPage memory trustPage
    ) {
        v1Data = getV1Data(user);
        v2Data = getV2Data(user);
        trustPage = getTrustedAddressesPageFor(user, balanceHolder, startMarker, pageSize);
    }
}
